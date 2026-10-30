import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import type { SalesBotConfig } from '@/config/sales-bot.config';
import { GeminiClient } from '@/modules/ai/internal/gemini-client';
import { buildGeminiRequest, hasSendableContent } from '@/modules/ai/internal/gemini-request';
import type { ChatTurn, GeminiContent, GeminiPart } from '@/modules/ai/internal/gemini.types';
import { todayUtcDate } from '@/modules/reports/internal/range';

import { nowBogota } from '@/common/utils/dayjs';

import { buildSellerGreeting, timeOfDayFromHour } from './internal/greeting';
import { buildSellerSystemPrompt, SELLER_ASSISTANT_NAME } from './internal/seller-prompt';
import { SELLER_TOOLS } from './internal/seller-tools';
import { SellerToolRunner, type SellerToolContext } from './internal/seller-tool-runner';
import type { ClosedOrder, SellerReply } from './internal/types';
import { SalesBotSettingsService } from './sales-bot-settings.service';
import { SellerCartService } from './seller-cart.service';
import { SalesAgentAccessService } from '@/modules/sales-agent-access/sales-agent-access.service';
import { addUsage, EMPTY_USAGE } from '@/modules/ai/internal/ai-usage';
import { describeCartForPrompt } from './internal/cart';

/** Opciones por mensaje que el canal le pasa al vendedor. */
export interface SellerMessageOptions {
  /** `true` si es el primer mensaje del cliente hoy (hora Colombia). */
  firstMessageOfDay?: boolean;
}

/** Datos públicos del negocio para el vendedor. */
interface BusinessProfile {
  name: string;
  address: string | null;
  phone: string | null;
}

/** Vigencia de la caché de datos del negocio (5 min). */
const BUSINESS_PROFILE_TTL_MS = 5 * 60 * 1000;

/** Nota de voz del cliente (base64) que el canal descargó. */
export interface SellerAudioInput {
  /** Negocio que recibe la nota de voz (su consumo de IA suma a la cuenta). */
  companyId: number;
  /** Contenido del audio en base64 (sin prefijo `data:`). */
  data: string;
  /** Tipo MIME (`audio/ogg; codecs=opus` en WhatsApp/Telegram). */
  mime_type: string;
}

/** Tope del audio en base64 (~12 MB): notas de voz de varios minutos caben. */
export const MAX_AUDIO_BASE64_LENGTH = 16 * 1024 * 1024;

/** Respuesta cuando no se pudo entender (o procesar) una nota de voz. */
export const AUDIO_NOT_UNDERSTOOD_REPLY =
  'Uy, no logré escuchar bien tu audio 🙈 ¿Me lo escribes o me mandas otro, por favor?';

const TRANSCRIBE_INSTRUCTION =
  'Transcribe literalmente lo que dice esta nota de voz (español de Colombia). Devuelve SOLO el texto dicho, sin comillas, etiquetas ni comentarios. Si no hay voz o no se entiende nada, responde exactamente: [inaudible]';

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
  private readonly profileCache = new Map<number, { profile: BusinessProfile; at: number }>();

  constructor(
    private readonly configService: ConfigService,
    private readonly gemini: GeminiClient,
    private readonly toolRunner: SellerToolRunner,
    private readonly dataSource: DataSource,
    private readonly botSettings: SalesBotSettingsService,
    private readonly cart: SellerCartService,
    private readonly access: SalesAgentAccessService,
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
  async handleMessage(
    context: SellerToolContext,
    turns: ChatTurn[],
    options: SellerMessageOptions = {},
  ): Promise<SellerReply> {
    if (!this.gemini.isEnabled()) {
      return { reply: FALLBACK_REPLY, orders: [] };
    }

    try {
      return await this.run(context, turns, options);
    } catch (error) {
      this.logger.error(
        { err: error, companyId: context.companyId, channel: context.channel },
        'Fallo atendiendo mensaje del vendedor',
      );
      return { reply: FALLBACK_REPLY, orders: [] };
    }
  }

  /**
   * Transcribe una nota de voz del cliente a texto, para atenderla como un
   * mensaje escrito (misma memoria, mismo flujo en todos los canales). Devuelve
   * `null` si no hay IA, el audio no es válido o no se entendió nada. Nunca lanza.
   */
  async transcribeAudio(audio: SellerAudioInput): Promise<string | null> {
    const data = audio.data?.trim() ?? '';
    const mimeType = audio.mime_type?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!this.gemini.isEnabled() || !data || !mimeType.startsWith('audio/')) {
      return null;
    }
    if (data.length > MAX_AUDIO_BASE64_LENGTH) {
      return null;
    }

    try {
      const body = {
        contents: [
          {
            role: 'user' as const,
            parts: [{ inlineData: { mimeType, data } }, { text: TRANSCRIBE_INSTRUCTION }],
          },
        ],
        generationConfig: {
          temperature: 0,
          topP: 1,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: this.config.thinkingBudget },
        },
      };
      const model = this.gemini.resolveModel(this.config.model);
      const result = await this.streamRoundWithRetry(body, model);
      await this.access.recordUsage({
        companyId: audio.companyId,
        kind: 'sales_agent_audio',
        model,
        usage: result.usage,
        rounds: 1,
      });
      const text = result.error ? '' : result.text.trim();
      if (!text || /^\[?inaudible\]?\.?$/i.test(text)) {
        return null;
      }
      return text;
    } catch (error) {
      this.logger.error({ err: error }, 'No se pudo transcribir la nota de voz');
      return null;
    }
  }

  /**
   * Saludo + presentación del vendedor (nombre, negocio, tono de la
   * personalidad y franja horaria de Colombia). Lo usan los canales cuando el
   * cliente reinicia la conversación (/start). No llama a la IA.
   */
  async greeting(companyId: number): Promise<string> {
    const { name: businessName } = await this.businessProfile(companyId);
    // La persona es la misma en todos los canales (ajustes del agente).
    const settings = await this.botSettings.get(companyId);
    return buildSellerGreeting({
      assistantName: settings.bot_name || SELLER_ASSISTANT_NAME,
      businessName,
      personality: settings.personality,
      timeOfDay: timeOfDayFromHour(nowBogota().hour()),
    });
  }

  private async run(
    context: SellerToolContext,
    turns: ChatTurn[],
    options: SellerMessageOptions,
  ): Promise<SellerReply> {
    const config = this.config;
    const business = await this.businessProfile(context.companyId);
    const settings = await this.botSettings.get(context.companyId);
    // Sin dirección no hay punto físico: todo pedido es a domicilio.
    const pickupAvailable = Boolean(business.address);
    const cart = context.conversation ? await this.cart.get(context.conversation) : null;
    const model = this.gemini.resolveModel(config.model);

    const systemPrompt = buildSellerSystemPrompt({
      businessName: business.name,
      businessAddress: business.address,
      businessPhone: business.phone,
      channel: context.channel,
      today: todayUtcDate(),
      customerName: context.chatDisplayName,
      assistantName: settings.bot_name,
      personality: settings.personality,
      firstMessageOfDay: options.firstMessageOfDay,
      timeOfDay: timeOfDayFromHour(nowBogota().hour()),
      stockPolicy: settings.stock_policy,
      cartBlock: context.conversation
        ? describeCartForPrompt(cart, { pickupAvailable })
        : undefined,
    });
    // Las herramientas también obedecen la política de stock (ocultan el stock
    // al modelo cuando el negocio pide ofrecer siempre).
    const toolContext: SellerToolContext = {
      ...context,
      stockPolicy: settings.stock_policy,
      pickupAvailable,
    };

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
    (body.generationConfig as { thinkingConfig?: { thinkingBudget: number } }).thinkingConfig = {
      thinkingBudget: config.thinkingBudget,
    };

    if (!hasSendableContent(body)) {
      return { reply: '¿En qué te puedo ayudar? 😊', orders: [] };
    }

    const orders: ClosedOrder[] = [];
    const roundTexts: string[] = [];
    // Consumo del mensaje: SUMA de todas sus rondas; suma a la IA de la cuenta.
    let usage = EMPTY_USAGE;
    let rounds = 0;

    try {
      for (let round = 0; round <= config.maxToolRounds; round += 1) {
        const isLastRound = round === config.maxToolRounds;
        const roundBody = isLastRound ? { ...body, tools: undefined } : body;

        const result = await this.streamRoundWithRetry(roundBody, model);
        usage = addUsage(usage, result.usage);
        rounds += 1;

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
          const execution = await this.toolRunner.execute(call, toolContext);
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
    } finally {
      await this.access.recordUsage({
        companyId: context.companyId,
        kind: 'sales_agent',
        model,
        usage,
        rounds,
      });
    }
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
    if (!first.error) {
      return first;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = await this.gemini.streamRound(body, { model, onText: () => undefined });
    return second;
  }

  /**
   * Datos públicos del negocio (nombre, dirección, teléfono) que el vendedor
   * puede dar al cliente. Caché corta: si el dueño edita su dirección, el
   * agente la toma en pocos minutos.
   */
  private async businessProfile(companyId: number): Promise<BusinessProfile> {
    const cached = this.profileCache.get(companyId);
    if (cached && Date.now() - cached.at < BUSINESS_PROFILE_TTL_MS) {
      return cached.profile;
    }

    const rows = await this.dataSource.query<
      Array<{ name: string | null; address: string | null; phone_number: string | null }>
    >('SELECT name, address, phone_number FROM companies WHERE id = $1 LIMIT 1', [companyId]);
    const row = rows[0];
    const profile: BusinessProfile = {
      name: row?.name?.trim() || 'nuestro negocio',
      address: row?.address?.trim() || null,
      phone: row?.phone_number?.trim() || null,
    };
    this.profileCache.set(companyId, { profile, at: Date.now() });
    return profile;
  }
}

/** Une los textos de cada ronda con un salto, evitando dobles vacíos. */
const joinTexts = (texts: string[]): string =>
  texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
    .trim();
