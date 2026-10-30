import { Logger } from '@nestjs/common';

import type { SalesAgentService } from '../../seller-agent.service';
import { formatOrderForOwner } from '../../internal/order-format';
import { SellerSessionStore } from '../../internal/session-store';
import type { ClosedOrder } from '../../internal/types';
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
    this.client = new TelegramClient(params.token);
  }

  /** Arranca el bucle en segundo plano (no bloquea). Idempotente. */
  start(): void {
    if (this.running) return;
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
        const updates = await this.client.getUpdates(
          this.offset,
          this.params.longPollTimeoutSec,
        );
        for (const update of updates) {
          // Avanza SIEMPRE el offset, incluso para lo que no atendemos (fotos,
          // stickers), para no releerlo en el siguiente ciclo.
          this.offset = Math.max(this.offset, update.updateId + 1);
          if (!this.running) break;
          if (update.text.length === 0) continue;
          await this.handle(update);
        }
        this.params.sessions.pruneExpired();
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

  private async handle(update: TelegramIncomingMessage): Promise<void> {
    const { companyId, agent, sessions, ownerChatId } = this.params;
    // La clave de sesión incluye el negocio para no cruzar conversaciones entre
    // bots distintos que compartan el proceso.
    const sessionKey = SellerSessionStore.key(`${CHANNEL}:${companyId}`, update.chatId);

    // Comandos de control: reinician la conversación con un saludo.
    if (RESET_COMMANDS.has(update.text.toLowerCase())) {
      sessions.reset(sessionKey);
      await this.client.sendMessage(
        update.chatId,
        '¡Hola! 👋 Soy tu asesor. ¿En qué te puedo ayudar hoy?',
      );
      return;
    }

    await this.client.sendTyping(update.chatId);

    const turns = sessions.append(sessionKey, { role: 'user', content: update.text });

    const result = await agent.handleMessage(
      {
        companyId,
        channel: CHANNEL,
        chatId: update.chatId,
        chatDisplayName: update.senderName,
      },
      turns,
    );

    sessions.append(sessionKey, { role: 'assistant', content: result.reply });
    await this.client.sendMessage(update.chatId, result.reply);

    // Avisa al dueño de cada pedido cerrado, deduplicando: si el modelo cerró el
    // mismo pedido dos veces (doble "sí"), solo se notifica una vez.
    for (const order of result.orders) {
      const signature = orderSignature(order);
      if (!sessions.rememberOrder(sessionKey, signature)) {
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Firma estable de un pedido (líneas + total) para detectar un doble cierre. */
const orderSignature = (order: ClosedOrder): string => {
  const lines = order.items
    .map((item) => `${item.name}|${item.quantity}|${item.unit_price}`)
    .sort()
    .join(';');
  return `${lines}#${order.total}`;
};
