import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import type { AiConfig } from '@/config/ai.config';
import { todayUtcDate } from '@/modules/reports/internal/range';

import { addUsage, EMPTY_USAGE } from '../internal/ai-usage';
import {
  buildAttachmentPartsResolver,
  collectAttachmentIds,
  normalizeAttachmentTurns,
} from '../internal/attachments';
import { extractRequestContext } from '../internal/expense-tool-helpers';
import { GeminiClient } from '../internal/gemini-client';
import { buildGeminiRequest, hasSendableContent } from '../internal/gemini-request';
import { describeBlockReason, describeFinishReason } from '../internal/gemini-sse';
import type { ChatTurn, GeminiContent, GeminiPart, GeminiUsage } from '../internal/gemini.types';
import { buildSystemPrompt } from '../internal/system-prompt';
import { AI_TOOLS, declarationsFor, isToolAllowed } from '../internal/tool-catalog';
import type { AiToolCard } from '../internal/tool-cards';

import { AiAttachmentsAction } from './ai-attachments.action';
import { AiCreditsAction } from './ai-credits.action';
import { ResolveAiActorAction } from './resolve-ai-actor.action';
import { RunAiToolAction } from './run-ai-tool.action';

/**
 * Instrucción de la última ronda (ya sin herramientas). Va solo en esa ronda,
 * no queda en el historial del cliente.
 */
export const FINAL_ROUND_PROMPT =
  '(Mensaje del sistema, no del usuario) Ya no puedes consultar más herramientas en esta respuesta. Responde AHORA al usuario, en español, con lo que ya sabes: qué encontraste y qué necesitas que te aclare. No dejes la respuesta vacía.';

/** Eventos que viajan al cliente por SSE. */
export type AiStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; label: string; status: 'running' | 'done' | 'error' }
  | { type: 'card'; card: AiToolCard }
  | { type: 'done'; notice?: string }
  | { type: 'error'; message: string };

/** Consumo acumulado de una pregunta mientras se responde. */
interface UsageTracker {
  usage: GeminiUsage;
  rounds: number;
  model: string;
}

export interface StreamAiChatParams {
  user: AuthUser;
  companyId: number;
  turns: ChatTurn[];
  model?: string;
  /** Se dispara con cada evento; el controller lo escribe al response. */
  emit: (event: AiStreamEvent) => void;
  /** Se aborta cuando el cliente cierra la conexión. */
  signal: AbortSignal;
}

/**
 * Orquesta una respuesta completa de PlacePOS IA.
 *
 * Ciclo: el modelo genera texto y/o pide herramientas; si pidió herramientas se
 * ejecutan (filtradas por permisos y por company; solo lectura salvo las de
 * gastos, que exigen confirmación en un turno posterior), se le devuelven
 * los resultados y se le vuelve a preguntar. Se corta a `maxToolRounds` rondas
 * para que ninguna conversación pueda quedarse en bucle.
 *
 * Nunca lanza: cualquier fallo termina en un evento `error` con un mensaje en
 * español. Un stream a medias no debe romper la UI del cliente.
 */
@Injectable()
export class StreamAiChatAction {
  private readonly logger = new Logger(StreamAiChatAction.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly geminiClient: GeminiClient,
    private readonly resolveActor: ResolveAiActorAction,
    private readonly runTool: RunAiToolAction,
    private readonly credits: AiCreditsAction,
    private readonly attachments: AiAttachmentsAction,
  ) {}

  async execute(params: StreamAiChatParams): Promise<void> {
    // Consumo de TODAS las rondas de esta pregunta; se registra pase lo que pase
    // (respuesta completa, error, abortada).
    const tracker: UsageTracker = {
      usage: EMPTY_USAGE,
      rounds: 0,
      model: this.geminiClient.resolveModel(params.model),
    };
    try {
      await this.run(params, tracker);
    } finally {
      if (tracker.rounds > 0) {
        await this.credits.recordUsage({
          company_id: params.companyId,
          user_id: params.user.user_id ?? null,
          kind: 'chat',
          model: tracker.model,
          usage: tracker.usage,
          rounds: tracker.rounds,
        });
      }
    }
  }

  private async run(
    { user, companyId, turns: raw_turns, model, emit, signal }: StreamAiChatParams,
    tracker: UsageTracker,
  ): Promise<void> {
    const config = this.configService.getOrThrow<AiConfig>('ai');

    if (!this.geminiClient.isEnabled()) {
      emit({
        type: 'error',
        message: 'PlacePOS IA no está configurada en el servidor. Contacta al administrador.',
      });
      return;
    }

    // Un mensaje con solo archivos se vuelve "(Adjunté un archivo)": el
    // historial y las confirmaciones trabajan con texto.
    const turns = normalizeAttachmentTurns(raw_turns);
    const attachment_ids = collectAttachmentIds(turns);

    const [actor, resolved_attachments] = await Promise.all([
      this.resolveActor.execute(user, companyId),
      // Solo los del MISMO usuario y company y vigentes: el id ajeno o vencido
      // se le presenta al modelo como "ya no disponible".
      this.attachments.resolve(companyId, user.user_id, attachment_ids.all),
    ]);
    const resolvedModel = this.geminiClient.resolveModel(model);

    const availableTools = AI_TOOLS.filter((tool) => isToolAllowed(tool, actor)).map((tool) => ({
      name: tool.name,
      description: tool.declaration.description,
    }));

    const systemPrompt = buildSystemPrompt({
      businessName: actor.businessName,
      userName: actor.userName,
      userRole: actor.userRole,
      today: todayUtcDate(),
      availableTools,
      canViewProfit: actor.canViewProfit,
      businesses: actor.businesses,
      current_company_id: companyId,
    });

    const body = buildGeminiRequest({
      turns,
      systemPrompt,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      tools: declarationsFor(actor),
      attachmentParts: buildAttachmentPartsResolver(resolved_attachments, attachment_ids.included),
    });

    if (!hasSendableContent(body)) {
      emit({ type: 'error', message: 'No hay ningún mensaje que enviar.' });
      return;
    }

    // Identidad de ESTA petición + los mensajes del usuario: con esto las
    // herramientas de gastos exigen que la confirmación llegue en un turno
    // posterior y responda exactamente al resumen preparado.
    const requestContext = extractRequestContext(turns, randomUUID());

    let emittedText = 0;

    for (let round = 0; round <= config.maxToolRounds; round += 1) {
      if (signal.aborted) {
        return;
      }

      // En la última ronda se le quitan las herramientas: obligamos a que
      // responda con texto en vez de pedir otra consulta que ya no correremos.
      const isLastRound = round === config.maxToolRounds;
      // Sin herramientas el modelo a veces responde VACÍO (quería otra
      // consulta). Se le dice explícitamente que conteste con lo que tiene.
      const roundBody = isLastRound
        ? {
            ...body,
            tools: undefined,
            contents: [
              ...body.contents,
              { role: 'user' as const, parts: [{ text: FINAL_ROUND_PROMPT }] },
            ],
          }
        : body;

      const result = await this.geminiClient.streamRound(roundBody, {
        model: resolvedModel,
        signal,
        onText: (text) => {
          emittedText += text.length;
          emit({ type: 'delta', text });
        },
      });

      tracker.rounds += 1;
      tracker.usage = addUsage(tracker.usage, result.usage);

      if (signal.aborted) {
        return;
      }

      if (result.error) {
        emit({ type: 'error', message: result.error });
        return;
      }

      const blocked = describeBlockReason(result.blockReason);
      if (blocked) {
        emit({ type: 'error', message: blocked });
        return;
      }

      // Sin llamadas a herramientas → la respuesta está completa.
      if (result.functionCalls.length === 0) {
        const notice = describeFinishReason(result.finishReason);
        if (emittedText === 0 && !notice) {
          emit({
            type: 'error',
            message: 'El modelo no devolvió ninguna respuesta. Intenta reformular tu pregunta.',
          });
          return;
        }
        emit({ type: 'done', notice: notice ?? undefined });
        return;
      }

      // Ronda de herramientas: se reenvían las partes del modelo tal cual
      // (incluyen firmas de razonamiento que la API exige devolver intactas).
      const modelContent: GeminiContent = {
        role: 'model',
        parts: result.parts.length > 0 ? result.parts : [{ text: result.text }],
      };
      body.contents.push(modelContent);

      const responseParts: GeminiPart[] = [];
      for (const call of result.functionCalls) {
        if (signal.aborted) {
          return;
        }

        const definition = AI_TOOLS.find((tool) => tool.name === call.name);
        const label = definition?.label ?? call.name;
        emit({ type: 'tool', name: call.name, label, status: 'running' });

        const execution = await this.runTool.execute(
          companyId,
          actor,
          call.name,
          call.args ?? {},
          requestContext,
        );

        emit({
          type: 'tool',
          name: call.name,
          label: execution.label,
          status: execution.ok ? 'done' : 'error',
        });

        // La vista previa (o el pedido creado) se dibuja con los datos del
        // servidor, nunca con lo que el modelo escriba de ella.
        if (execution.card) {
          emit({ type: 'card', card: execution.card });
        }

        this.logger.log(
          {
            companyId,
            userId: user.user_id,
            tool: call.name,
            ok: execution.ok,
            durationMs: execution.durationMs,
          },
          'Herramienta de IA ejecutada',
        );

        responseParts.push({
          functionResponse: { name: call.name, response: execution.response },
        });
      }

      body.contents.push({ role: 'user', parts: responseParts });
    }

    // Se agotaron las rondas sin respuesta final.
    emit({
      type: 'done',
      notice:
        emittedText > 0
          ? undefined
          : 'La consulta necesitó demasiadas búsquedas y no se completó. Intenta con una pregunta más concreta.',
    });
  }
}
