import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { WhatsappConfig } from '@/config/whatsapp.config';
import { SalesAgentAccessService } from '@/modules/sales-agent-access/sales-agent-access.service';
import { todayUtcDate } from '@/modules/reports/internal/range';

import { formatOrderForOwner } from '../../internal/order-format';
import { SellerSessionStore } from '../../internal/session-store';
import type { ClosedOrder } from '../../internal/types';
import { SalesAgentService } from '../../seller-agent.service';
import { SalesBotConfigService } from '../../sales-bot-config.service';
import { WhatsappClient } from './whatsapp.client';
import type { WhatsappIncomingMessage } from './whatsapp-webhook.parser';

const CHANNEL = 'whatsapp';

/** Comandos que reinician la conversación. */
const RESET_COMMANDS = new Set(['/reiniciar', '/start', '/nuevo', 'reiniciar']);

/** Tope de ids de mensaje recordados para no reprocesar reentregas de Meta. */
const MAX_SEEN_MESSAGES = 2000;

/**
 * Procesa los mensajes entrantes de WhatsApp: rutea cada uno al negocio dueño
 * del `phone_number_id`, deja que el vendedor Place responda y envía la
 * respuesta por la Cloud API. Avisa al dueño de cada pedido cerrado.
 *
 * Multi-tenant por ruteo (un solo webhook): el negocio sale de la config por
 * `phone_number_id`. El cerebro (`SalesAgentService`) es el mismo de Telegram.
 */
@Injectable()
export class WhatsappHandlerService {
  private readonly logger = new Logger(WhatsappHandlerService.name);
  private readonly client: WhatsappClient;
  /** Ids de mensaje ya procesados (anti reentrega de Meta). Acotado por tamaño. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly agent: SalesAgentService,
    private readonly sessions: SellerSessionStore,
    private readonly botConfig: SalesBotConfigService,
    private readonly access: SalesAgentAccessService,
  ) {
    this.client = new WhatsappClient(this.config.graphApiVersion);
  }

  private get config(): WhatsappConfig {
    return this.configService.getOrThrow<WhatsappConfig>('whatsapp');
  }

  /** Procesa un lote de mensajes. Nunca lanza (lo llama el webhook sin await). */
  async process(messages: WhatsappIncomingMessage[]): Promise<void> {
    for (const message of messages) {
      try {
        await this.handle(message);
      } catch (error) {
        this.logger.error({ err: error }, 'Fallo procesando mensaje de WhatsApp');
      }
    }
  }

  private async handle(message: WhatsappIncomingMessage): Promise<void> {
    if (this.seen.has(message.messageId)) return;
    this.remember(message.messageId);

    const tenant = await this.botConfig.findActiveWhatsappByPhoneNumberId(message.phoneNumberId);
    if (!tenant) {
      this.logger.log(
        { phoneNumberId: message.phoneNumberId },
        'Mensaje de WhatsApp sin negocio activo para ese número; ignorado.',
      );
      return;
    }
    if (!this.agent.isReady()) return;
    // Agente inhabilitado para el negocio (panel superadmin): no responde nada.
    if (!(await this.access.isEnabled(Number(tenant.company_id)))) return;

    const token = tenant.whatsapp_access_token?.trim() || this.config.accessToken;
    if (!token) {
      this.logger.warn(
        { companyId: tenant.company_id },
        'WhatsApp activo pero sin token (ni propio ni compartido); no respondo.',
      );
      return;
    }

    const companyId = Number(tenant.company_id);
    const send = { phoneNumberId: message.phoneNumberId, to: message.from, token };

    // Marca leído (best-effort, no bloquea).
    void this.client.markRead({
      phoneNumberId: message.phoneNumberId,
      token,
      messageId: message.messageId,
    });

    const sessionKey = SellerSessionStore.key(companyId, CHANNEL, message.from);

    const today = todayUtcDate();

    if (RESET_COMMANDS.has(message.text.toLowerCase())) {
      // En silencio por fuera de tema, reiniciar no sirve para saltarse el filtro.
      if (await this.agent.isMuted(sessionKey)) return;
      await this.sessions.reset(sessionKey);
      const greeting = await this.agent.greeting(companyId);
      await this.sessions.markDay(sessionKey, today);
      await this.client.sendText({ ...send, text: greeting });
      return;
    }

    const firstMessageOfDay = await this.sessions.markDay(sessionKey, today);
    const turns = await this.sessions.append(sessionKey, { role: 'user', content: message.text });

    const result = await this.agent.handleMessage(
      {
        companyId,
        channel: CHANNEL,
        chatId: message.from,
        chatDisplayName: message.senderName,
        channelAccount: message.displayPhoneNumber,
        conversation: sessionKey,
      },
      turns,
      { firstMessageOfDay },
    );

    // En silencio y el mensaje tampoco era del negocio: no se responde nada.
    if (result.silent) return;

    await this.sessions.append(sessionKey, { role: 'assistant', content: result.reply });
    await this.client.sendText({ ...send, text: result.reply });

    // Avisa al dueño de cada pedido cerrado (dedupe por sesión).
    const ownerChatId = tenant.owner_chat_id?.trim();
    for (const order of result.orders) {
      const signature = orderSignature(order);
      if (!(await this.sessions.rememberOrder(sessionKey, signature))) continue;
      if (ownerChatId) {
        await this.client.sendText({
          phoneNumberId: message.phoneNumberId,
          to: ownerChatId,
          token,
          text: formatOrderForOwner(order),
        });
      } else {
        this.logger.log(
          { companyId, total: order.total, lines: order.items.length },
          'Pedido cerrado por WhatsApp; el negocio no configuró número de avisos (solo log).',
        );
      }
    }
    // Avisos para el negocio (cancelación, solicitud sobre un pedido tomado).
    for (const notice of result.notices ?? []) {
      if (ownerChatId) {
        await this.client.sendText({
          phoneNumberId: message.phoneNumberId,
          to: ownerChatId,
          token,
          text: notice,
        });
      } else {
        this.logger.log({ companyId, notice }, 'Aviso al negocio sin número de avisos (solo log).');
      }
    }
  }

  private remember(messageId: string): void {
    this.seen.add(messageId);
    if (this.seen.size > MAX_SEEN_MESSAGES) {
      // Descarta el más viejo (Set mantiene orden de inserción).
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

/** Firma estable de un pedido (líneas + total) para detectar un doble cierre. */
const orderSignature = (order: ClosedOrder): string => {
  const lines = order.items
    .map((item) => `${item.name}|${item.quantity}|${item.unit_price}`)
    .sort()
    .join(';');
  return `${lines}#${order.total}`;
};
