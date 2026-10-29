import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import type { SalesBotConfig } from '@/config/sales-bot.config';
import { GeminiClient } from '@/modules/ai/internal/gemini-client';
import { buildGeminiRequest, hasSendableContent } from '@/modules/ai/internal/gemini-request';
import type { ChatTurn, GeminiContent, GeminiPart } from '@/modules/ai/internal/gemini.types';
import { todayUtcDate } from '@/modules/reports/internal/range';

import { buildSellerSystemPrompt } from './internal/seller-prompt';
import { SELLER_TOOLS } from './internal/seller-tools';
import { SellerToolRunner, type SellerToolContext } from './internal/seller-tool-runner';
import type { ClosedOrder, SellerReply } from './internal/types';

/** Último recurso cuando el servidor no tiene IA o algo falla feo. */
const FALLBACK_REPLY =
  'Disculpa, en este momento no puedo atenderte por aquí. Por favor intenta de nuevo en unos minutos. 🙏';

/**
 * Cerebro del vendedor Place para canales de chat. Orquesta el ciclo de Gemini
 * con function calling (igual que el chat del dueño, pero SIN streaming: el bot
 * responde un mensaje completo) usando la persona de vendedor y solo las
 * herramientas de inventario del negocio.
 */
@Injectable()
export class SalesAgentService {
  private readonly logger = new Logger(SalesAgentService.name);
  private readonly businessNameCache = new Map<number, string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly gemini: GeminiClient,
    private readonly toolRunner: SellerToolRunner,
    private readonly dataSource: DataSource,
  ) {}

  private get config(): SalesBotConfig {
    return this.configService.getOrThrow<SalesBotConfig>('salesBot');
  }

  /** `true` si el vendedor puede operar (IA configurada en el servidor). */
  isReady(): boolean {
    return this.gemini.isEnabled();
  }

  /**
   * Atiende un mensaje del cliente. `turns` ya incluye el mensaje nuevo al final.
   * Nunca lanza: cualquier fallo se traduce en una respuesta cordial para no
   * dejar al cliente en visto.
   */
  async handleMessage(context: SellerToolContext, turns: ChatTurn[]): Promise<SellerReply> {
    if (!this.gemini.isEnabled()) {
      return { reply: FALLBACK_REPLY, orders: [] };
    }

    try {
      return await this.run(context, turns);
    } catch (error) {
      this.logger.error(
        { err: error, companyId: context.companyId, channel: context.channel },
        'Fallo atendiendo mensaje del vendedor',
      );
      return { reply: FALLBACK_REPLY, orders: [] };
    }
  }

  private async run(context: SellerToolContext, turns: ChatTurn[]): Promise<SellerReply> {
    const config = this.config;
    const businessName = await this.businessName(context.companyId);
    const model = this.gemini.resolveModel(config.model);

    const systemPrompt = buildSellerSystemPrompt({
      businessName,
      today: todayUtcDate(),
      customerName: context.chatDisplayName,
    });

    const body = buildGeminiRequest({
      turns,
      systemPrompt,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      tools: [...SELLER_TOOLS],
    });

    // Vendedor = razonamiento BAJO para responder más rápido sin perder criterio.
    // Con herramientas este modelo NO acepta thinkingBudget 0 (error 400), así que
    // se usa un presupuesto bajo configurable. `thinkingConfig` no está en el tipo
    // compartido (el chat del dueño razona a fondo), por eso se agrega solo aquí.
    (
      body.generationConfig as { thinkingConfig?: { thinkingBudget: number } }
    ).thinkingConfig = { thinkingBudget: config.thinkingBudget };

    if (!hasSendableContent(body)) {
      return { reply: '¿En qué te puedo ayudar? 😊', orders: [] };
    }

    const orders: ClosedOrder[] = [];
    const roundTexts: string[] = [];

    for (let round = 0; round <= config.maxToolRounds; round += 1) {
      const isLastRound = round === config.maxToolRounds;
      const roundBody = isLastRound ? { ...body, tools: undefined } : body;

      const result = await this.streamRoundWithRetry(roundBody, model);

      if (result.error) {
        const partial = joinTexts(roundTexts);
        return { reply: partial || FALLBACK_REPLY, orders };
      }

      if (result.text.trim().length > 0) {
        roundTexts.push(result.text.trim());
      }

      // Sin llamadas a herramientas → el vendedor ya respondió.
      if (result.functionCalls.length === 0) {
        const reply = joinTexts(roundTexts);
        return { reply: reply || '¿Te puedo ayudar con algo más? 😊', orders };
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
        const execution = await this.toolRunner.execute(call, context);
        if (execution.order) {
          orders.push(execution.order);
        }
        responseParts.push({
          functionResponse: { name: call.name, response: execution.response },
        });
      }
      body.contents.push({ role: 'user', parts: responseParts });
    }

    // Se agotaron las rondas: devuelve lo que haya dicho, o un cierre cordial.
    const reply = joinTexts(roundTexts);
    return {
      reply: reply || 'Dame un momento para confirmarte y seguimos. 🙏',
      orders,
    };
  }

  /**
   * Corre una ronda de Gemini con UN reintento ante error. El cliente ya
   * reintenta los errores HTTP transitorios, pero no los fallos de transporte
   * (fetch que revienta / corte de stream), que en algunas redes aparecen de
   * forma intermitente. Como el bot NO hace streaming al cliente (solo usa el
   * texto final), repetir una ronda fallida es seguro: no duplica nada visible.
   */
  private async streamRoundWithRetry(
    body: Parameters<GeminiClient['streamRound']>[0],
    model: string,
  ): Promise<Awaited<ReturnType<GeminiClient['streamRound']>>> {
    const first = await this.gemini.streamRound(body, { model, onText: () => undefined });
    if (!first.error) return first;

    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = await this.gemini.streamRound(body, { model, onText: () => undefined });
    return second;
  }

  /** Nombre comercial del negocio (cacheado): el vendedor vende EN su nombre. */
  private async businessName(companyId: number): Promise<string> {
    const cached = this.businessNameCache.get(companyId);
    if (cached) return cached;

    const rows = await this.dataSource.query<Array<{ name: string }>>(
      'SELECT name FROM companies WHERE id = $1 LIMIT 1',
      [companyId],
    );
    const name = rows[0]?.name?.trim() || 'nuestro negocio';
    this.businessNameCache.set(companyId, name);
    return name;
  }
}

/** Une los textos de cada ronda con un salto, evitando dobles vacíos. */
const joinTexts = (texts: string[]): string =>
  texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
    .trim();
