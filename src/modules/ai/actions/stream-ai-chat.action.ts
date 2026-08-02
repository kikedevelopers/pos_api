import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import type { AiConfig } from '@/config/ai.config';
import { todayUtcDate } from '@/modules/reports/internal/range';

import { GeminiClient } from '../internal/gemini-client';
import { buildGeminiRequest, hasSendableContent } from '../internal/gemini-request';
import { describeBlockReason, describeFinishReason } from '../internal/gemini-sse';
import type { ChatTurn, GeminiContent, GeminiPart } from '../internal/gemini.types';
import { buildSystemPrompt } from '../internal/system-prompt';
import { AI_TOOLS, declarationsFor, isToolAllowed } from '../internal/tool-catalog';

import { ResolveAiActorAction } from './resolve-ai-actor.action';
import { RunAiToolAction } from './run-ai-tool.action';

/** Eventos que viajan al cliente por SSE. */
export type AiStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; label: string; status: 'running' | 'done' | 'error' }
  | { type: 'done'; notice?: string }
  | { type: 'error'; message: string };

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
 * ejecutan (solo lectura, filtradas por permisos y por company), se le devuelven
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
  ) {}

  async execute({
    user,
    companyId,
    turns,
    model,
    emit,
    signal,
  }: StreamAiChatParams): Promise<void> {
    const config = this.configService.getOrThrow<AiConfig>('ai');

    if (!this.geminiClient.isEnabled()) {
      emit({
        type: 'error',
        message: 'PlacePOS IA no está configurada en el servidor. Contacta al administrador.',
      });
      return;
    }

    const actor = await this.resolveActor.execute(user, companyId);
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
    });

    const body = buildGeminiRequest({
      turns,
      systemPrompt,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      tools: declarationsFor(actor),
    });

    if (!hasSendableContent(body)) {
      emit({ type: 'error', message: 'No hay ningún mensaje que enviar.' });
      return;
    }

    let emittedText = 0;

    for (let round = 0; round <= config.maxToolRounds; round += 1) {
      if (signal.aborted) {
        return;
      }

      // En la última ronda se le quitan las herramientas: obligamos a que
      // responda con texto en vez de pedir otra consulta que ya no correremos.
      const isLastRound = round === config.maxToolRounds;
      const roundBody = isLastRound ? { ...body, tools: undefined } : body;

      const result = await this.geminiClient.streamRound(roundBody, {
        model: resolvedModel,
        signal,
        onText: (text) => {
          emittedText += text.length;
          emit({ type: 'delta', text });
        },
      });

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

        const execution = await this.runTool.execute(companyId, actor, call.name, call.args ?? {});

        emit({
          type: 'tool',
          name: call.name,
          label: execution.label,
          status: execution.ok ? 'done' : 'error',
        });

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
