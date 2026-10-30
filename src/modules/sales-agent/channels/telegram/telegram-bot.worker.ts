import { Logger } from '@nestjs/common';

import { todayUtcDate } from '@/modules/reports/internal/range';

import { AUDIO_NOT_UNDERSTOOD_REPLY, type SalesAgentService } from '../../seller-agent.service';
import type { SalesBotTakeoverService } from '../../sales-bot-takeover.service';
import { formatOrderForOwner, orderSignature } from '../../internal/order-format';
import { SellerSessionStore } from '../../internal/session-store';
import { TelegramClient, type TelegramIncomingMessage } from './telegram.client';

const CHANNEL = 'telegram';

/** Comandos que el cliente puede escribir para reiniciar la conversación. */
const RESET_COMMANDS = new Set(['/reiniciar', '/start', '/nuevo']);

export interface TelegramBotWorkerParams {
  companyId: number;
  token: string;
  /** Chat del dueño al que avisar pedidos cerrados; null = solo log. */
  ownerChatId: string | null;
  pollIntervalMs: number;
  longPollTimeoutSec: number;
  agent: SalesAgentService;
  sessions: SellerSessionStore;
  takeovers: SalesBotTakeoverService;
  /** Inyectable para tests; por defecto se crea con el token. */
  client?: TelegramClient;
}

/**
 * Bot de Telegram de UN negocio. Encapsula su propio cliente, offset y bucle de
 * long-polling. El `TelegramBotManager` crea y destruye un worker por cada
 * negocio con bot configurado y activo — así el canal es multi-tenant sin
 * reescribir el cerebro del vendedor (`SalesAgentService`), que es agnóstico del
 * canal.
 *
 * No usa webhooks: funciona sin URL pública (igual que la v1 por env).
 */
export class TelegramBotWorker {
  private readonly logger = new Logger(TelegramBotWorker.name);
  private readonly client: TelegramClient;
  private running = false;
  private offset = 0;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly params: TelegramBotWorkerParams) {
    this.client = params.client ?? new TelegramClient(params.token);
  }

  /** Arranca el bucle en segundo plano (no bloquea). Idempotente. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loopPromise = this.loop();
    this.logger.log(
      { companyId: this.params.companyId },
      'Bot de Telegram del negocio ACTIVO (long-polling).',
    );
  }

  /** Detiene el bucle y espera a que termine la iteración en curso. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = null;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.client.getUpdates(this.offset, this.params.longPollTimeoutSec);
        for (const update of updates) {
          // Avanza SIEMPRE el offset, incluso para lo que no atendemos (fotos,
          // stickers), para no releerlo en el siguiente ciclo.
          this.offset = Math.max(this.offset, update.updateId + 1);
          if (!this.running) {
            break;
          }
          await this.process(update);
        }
      } catch (error) {
        this.logger.error(
          { err: error, companyId: this.params.companyId },
          'Error en el bucle del bot de Telegram',
        );
      }

      if (this.running) {
        await delay(this.params.pollIntervalMs);
      }
    }
  }

  /**
   * Atiende un update ya normalizado. Público para poder probarlo sin el bucle.
   *
   * Telegram Business: el bot recibe los mensajes de AMBOS lados del chat de la
   * cuenta del dueño. Si escribe el lado del negocio y NO fue el bot, es una
   * persona tomando el control → el agente se calla en ese chat hasta mañana
   * (igual que en WhatsApp por QR).
   */
  async process(update: TelegramIncomingMessage): Promise<void> {
    const { companyId, takeovers } = this.params;
    const conversationId = conversationIdOf(update);

    if (update.fromBusinessSide) {
      if (!update.sentByBot) {
        await takeovers.pause(companyId, CHANNEL, conversationId);
        this.logger.log(
          { companyId, chatId: conversationId },
          'Una persona del negocio respondió; el agente se pausa en este chat.',
        );
      }
      return;
    }

    if (update.text.length === 0 && !update.voice) {
      return;
    }
    if (await takeovers.isPaused(companyId, CHANNEL, conversationId)) {
      return;
    }

    // Nota de voz → se transcribe y se atiende como si la hubiera escrito.
    if (update.text.length === 0 && update.voice) {
      const text = await this.transcribe(update.voice);
      if (!text) {
        await this.client.sendMessage(
          update.chatId,
          AUDIO_NOT_UNDERSTOOD_REPLY,
          update.businessConnectionId,
        );
        return;
      }
      await this.handle({ ...update, text }, conversationId);
      return;
    }

    await this.handle(update, conversationId);
  }

  private async transcribe(voice: { fileId: string; mimeType: string }): Promise<string | null> {
    const file = await this.client.downloadFile(voice.fileId);
    if (!file) {
      return null;
    }
    return this.params.agent.transcribeAudio({ data: file.data, mime_type: voice.mimeType });
  }

  private async handle(update: TelegramIncomingMessage, conversationId: string): Promise<void> {
    const { companyId, agent, sessions, ownerChatId, takeovers } = this.params;
    const businessConnectionId = update.businessConnectionId;
    // La clave de sesión incluye el negocio para no cruzar conversaciones entre
    // bots distintos que compartan el proceso.
    const sessionKey = SellerSessionStore.key(companyId, CHANNEL, conversationId);

    const today = todayUtcDate();

    // Comandos de control: reinician la conversación con un saludo que presenta
    // al bot (nombre, negocio y tono de su personalidad).
    if (RESET_COMMANDS.has(update.text.toLowerCase())) {
      await sessions.reset(sessionKey);
      const greeting = await agent.greeting(companyId);
      await sessions.markDay(sessionKey, today);
      await this.client.sendMessage(update.chatId, greeting, businessConnectionId);
      return;
    }

    await this.client.sendTyping(update.chatId, businessConnectionId);

    const firstMessageOfDay = await sessions.markDay(sessionKey, today);
    const turns = await sessions.append(sessionKey, { role: 'user', content: update.text });

    const result = await agent.handleMessage(
      {
        companyId,
        channel: CHANNEL,
        chatId: update.chatId,
        chatDisplayName: update.senderName,
      },
      turns,
      { firstMessageOfDay },
    );

    // Mientras la IA pensaba, una persona pudo tomar el chat: no la pisamos.
    if (await takeovers.isPaused(companyId, CHANNEL, conversationId)) {
      return;
    }

    await sessions.append(sessionKey, { role: 'assistant', content: result.reply });
    await this.client.sendMessage(update.chatId, result.reply, businessConnectionId);

    // Avisa al dueño de cada pedido cerrado, deduplicando: si el modelo cerró el
    // mismo pedido dos veces (doble "sí"), solo se notifica una vez.
    for (const order of result.orders) {
      const signature = orderSignature(order);
      if (!(await sessions.rememberOrder(sessionKey, signature))) {
        this.logger.log({ signature }, 'Pedido duplicado (doble cierre); no se re-notifica.');
        continue;
      }
      if (ownerChatId) {
        await this.client.sendMessage(ownerChatId, formatOrderForOwner(order));
      } else {
        this.logger.log(
          { companyId, total: order.total, lines: order.items.length },
          'Pedido cerrado; el negocio no configuró chat del dueño (solo log).',
        );
      }
    }
  }
}

/**
 * Id de la conversación para sesión y toma de control. Los chats de la cuenta
 * Business van aparte (`b:`) de los chats directos con el bot, aunque el
 * cliente sea el mismo.
 */
export const conversationIdOf = (update: TelegramIncomingMessage): string =>
  update.businessConnectionId ? `b:${update.chatId}` : update.chatId;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
