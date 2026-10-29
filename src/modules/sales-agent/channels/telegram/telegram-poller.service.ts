import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { SalesBotConfig } from '@/config/sales-bot.config';

import { SalesAgentService } from '../../seller-agent.service';
import { formatOrderForOwner } from '../../internal/order-format';
import { SellerSessionStore } from '../../internal/session-store';
import type { ClosedOrder } from '../../internal/types';
import { TelegramClient, type TelegramIncomingMessage } from './telegram.client';

const CHANNEL = 'telegram';

/** Comandos que el cliente puede escribir para controlar la conversación. */
const RESET_COMMANDS = new Set(['/reiniciar', '/start', '/nuevo']);

/**
 * Long-poller de Telegram: el único punto "vivo" del canal. Arranca con la app
 * (si está habilitado y hay token + negocio), consulta getUpdates en bucle y, por
 * cada mensaje de texto, deja que el vendedor Place responda. Avisa al dueño de
 * cada pedido cerrado.
 *
 * No usa webhooks: funciona en local sin URL pública (decisión de esta v1).
 */
@Injectable()
export class TelegramPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramPollerService.name);
  private client: TelegramClient | null = null;
  private running = false;
  private offset = 0;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly agent: SalesAgentService,
    private readonly sessions: SellerSessionStore,
  ) {}

  private get config(): SalesBotConfig {
    return this.configService.getOrThrow<SalesBotConfig>('salesBot');
  }

  onModuleInit(): void {
    const config = this.config;
    if (!config.enabled) {
      this.logger.log('Vendedor por Telegram deshabilitado (SALES_BOT_ENABLED != true).');
      return;
    }
    if (!config.telegram.token) {
      this.logger.warn('SALES_BOT_ENABLED=true pero falta SALES_BOT_TELEGRAM_TOKEN; no arranco.');
      return;
    }
    if (!config.companyId) {
      this.logger.warn('Falta SALES_BOT_COMPANY_ID: no sé para qué negocio vender; no arranco.');
      return;
    }
    if (!this.agent.isReady()) {
      this.logger.warn('IA (Gemini) no configurada en el servidor; el vendedor no arranca.');
      return;
    }

    this.client = new TelegramClient(config.telegram.token);
    this.running = true;
    // El bucle corre en segundo plano; no bloquea el arranque de Nest.
    this.loopPromise = this.loop();
    this.logger.log(
      { companyId: config.companyId },
      'Vendedor por Telegram ACTIVO (long-polling).',
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }
  }

  private async loop(): Promise<void> {
    const config = this.config;
    const client = this.client;
    if (!client) return;

    while (this.running) {
      try {
        const updates = await client.getUpdates(this.offset, config.telegram.longPollTimeoutSec);
        for (const update of updates) {
          // Avanza SIEMPRE el offset, incluso para lo que no atendemos (fotos,
          // stickers), para no releerlo en el siguiente ciclo.
          this.offset = Math.max(this.offset, update.updateId + 1);
          if (!this.running) break;
          if (update.text.length === 0) continue;
          await this.handle(update);
        }
        this.sessions.pruneExpired();
      } catch (error) {
        this.logger.error({ err: error }, 'Error en el bucle del vendedor de Telegram');
      }

      if (this.running) {
        await delay(config.telegram.pollIntervalMs);
      }
    }
  }

  private async handle(update: TelegramIncomingMessage): Promise<void> {
    const config = this.config;
    const client = this.client;
    const companyId = config.companyId;
    if (!client || !companyId) return;

    const sessionKey = SellerSessionStore.key(CHANNEL, update.chatId);

    // Comandos de control: reinician la conversación con un saludo.
    if (RESET_COMMANDS.has(update.text.toLowerCase())) {
      this.sessions.reset(sessionKey);
      await client.sendMessage(
        update.chatId,
        '¡Hola! 👋 Soy tu asesor. ¿En qué te puedo ayudar hoy?',
      );
      return;
    }

    await client.sendTyping(update.chatId);

    const turns = this.sessions.append(sessionKey, { role: 'user', content: update.text });

    const result = await this.agent.handleMessage(
      {
        companyId,
        channel: CHANNEL,
        chatId: update.chatId,
        chatDisplayName: update.senderName,
      },
      turns,
    );

    this.sessions.append(sessionKey, { role: 'assistant', content: result.reply });
    await client.sendMessage(update.chatId, result.reply);

    // Avisa al dueño de cada pedido cerrado, deduplicando: si el modelo cerró
    // el mismo pedido dos veces (doble "sí"), solo se notifica una vez.
    const ownerChatId = config.telegram.ownerChatId;
    for (const order of result.orders) {
      const signature = orderSignature(order);
      if (!this.sessions.rememberOrder(sessionKey, signature)) {
        this.logger.log({ signature }, 'Pedido duplicado (doble cierre); no se re-notifica.');
        continue;
      }
      if (ownerChatId) {
        await client.sendMessage(ownerChatId, formatOrderForOwner(order));
      } else {
        this.logger.log(
          { total: order.total, lines: order.items.length },
          'Pedido cerrado; SALES_BOT_TELEGRAM_OWNER_CHAT_ID no está configurado (solo log).',
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
