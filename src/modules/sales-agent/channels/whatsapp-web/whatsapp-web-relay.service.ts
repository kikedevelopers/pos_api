import { Injectable, Logger } from '@nestjs/common';

import { todayUtcDate } from '@/modules/reports/internal/range';

import { SALES_BOT_CHANNELS } from '../../entities/sales-bot-config.entity';
import { formatOrderForOwner, orderSignature } from '../../internal/order-format';
import { SellerSessionStore } from '../../internal/session-store';
import { AUDIO_NOT_UNDERSTOOD_REPLY, SalesAgentService } from '../../seller-agent.service';
import { SalesBotConfigService } from '../../sales-bot-config.service';
import { SalesBotTakeoverService } from '../../sales-bot-takeover.service';

const CHANNEL = 'whatsapp';

/** Comandos que reinician la conversación. */
const RESET_COMMANDS = new Set(['/reiniciar', '/start', '/nuevo', 'reiniciar']);

/** Tope de ids recordados para no responder dos veces el mismo mensaje. */
const MAX_SEEN_MESSAGES = 2000;

export interface WhatsappWebIncoming {
  /** JID del chat del cliente (tal cual lo entrega WhatsApp). */
  chat_id: string;
  /** Texto del cliente. Vacío si el mensaje es una nota de voz. */
  text?: string;
  sender_name?: string;
  message_id: string;
  /** Nota de voz en base64 (el escritorio la descarga de WhatsApp). */
  audio_base64?: string;
  audio_mime_type?: string;
}

/** Aviso que el escritorio debe enviar (p. ej. pedido cerrado → dueño). */
export interface WhatsappWebNotification {
  /** Número del destinatario (dígitos con indicativo). */
  to: string;
  text: string;
}

export interface WhatsappWebReplyResult {
  /** Texto a responder al cliente; `null` = no responder (bot apagado, duplicado...). */
  reply: string | null;
  notifications: WhatsappWebNotification[];
}

const NO_REPLY: WhatsappWebReplyResult = { reply: null, notifications: [] };

/**
 * Relay del WhatsApp conectado por QR (Baileys) en la app de ESCRITORIO.
 *
 * La sesión de WhatsApp vive en el PC del tenant; el escritorio nos pasa cada
 * mensaje entrante y nosotros devolvemos la respuesta del vendedor Place para
 * que él la envíe. El negocio sale del JWT del usuario logueado en ese PC, así
 * que no hay ruteo por número ni credenciales de Meta.
 *
 * El cerebro (`SalesAgentService`) y la memoria (`SellerSessionStore`) son los
 * mismos de Telegram / Cloud API.
 */
@Injectable()
export class WhatsappWebRelayService {
  private readonly logger = new Logger(WhatsappWebRelayService.name);
  private readonly seen = new Set<string>();

  constructor(
    private readonly agent: SalesAgentService,
    private readonly sessions: SellerSessionStore,
    private readonly botConfig: SalesBotConfigService,
    private readonly takeovers: SalesBotTakeoverService,
  ) {}

  /**
   * Un HUMANO respondió en este chat desde el teléfono/WhatsApp Web del
   * negocio: el agente se calla en ese chat hasta el inicio del día siguiente.
   */
  takeover(companyId: number, chatId: string): Promise<{ paused_until: string }> {
    return this.takeovers.pause(companyId, CHANNEL, chatId.trim());
  }

  async reply(companyId: number, input: WhatsappWebIncoming): Promise<WhatsappWebReplyResult> {
    const typed = input.text?.trim() ?? '';
    const audio = input.audio_base64?.trim() ?? '';
    const chatId = input.chat_id?.trim() ?? '';
    if ((!typed && !audio) || !chatId) {
      return NO_REPLY;
    }

    const messageKey = `${companyId}:${input.message_id}`;
    if (this.seen.has(messageKey)) {
      return NO_REPLY;
    }
    this.remember(messageKey);

    const config = await this.botConfig.getEntity(companyId, SALES_BOT_CHANNELS.WHATSAPP);
    if (!config?.enabled) {
      return NO_REPLY;
    }
    if (!this.agent.isReady()) {
      return NO_REPLY;
    }
    // Un humano tomó este chat: el agente no se mete hasta mañana.
    if (await this.takeovers.isPaused(companyId, CHANNEL, chatId)) {
      return NO_REPLY;
    }

    const sessionKey = SellerSessionStore.key(companyId, 'whatsapp-web', chatId);

    // Nota de voz → se transcribe y se atiende como si la hubiera escrito.
    const text =
      typed ||
      (await this.agent.transcribeAudio({
        data: audio,
        mime_type: input.audio_mime_type ?? '',
      })) ||
      '';
    if (!text) {
      return { reply: AUDIO_NOT_UNDERSTOOD_REPLY, notifications: [] };
    }

    const today = todayUtcDate();

    if (RESET_COMMANDS.has(text.toLowerCase())) {
      await this.sessions.reset(sessionKey);
      const greeting = await this.agent.greeting(companyId);
      // Ya se presentó: el siguiente mensaje de hoy no repite el saludo.
      await this.sessions.markDay(sessionKey, today);
      return { reply: greeting, notifications: [] };
    }

    const firstMessageOfDay = await this.sessions.markDay(sessionKey, today);
    const turns = await this.sessions.append(sessionKey, { role: 'user', content: text });
    const result = await this.agent.handleMessage(
      { companyId, channel: CHANNEL, chatId, chatDisplayName: input.sender_name },
      turns,
      { firstMessageOfDay },
    );

    // Si el humano intervino MIENTRAS el agente pensaba, se descarta la respuesta.
    if (await this.takeovers.isPaused(companyId, CHANNEL, chatId)) {
      return NO_REPLY;
    }

    await this.sessions.append(sessionKey, { role: 'assistant', content: result.reply });

    // Avisos al dueño por cada pedido cerrado (dedupe por sesión).
    const notifications: WhatsappWebNotification[] = [];
    const ownerNumber = config.owner_chat_id?.replace(/\D/g, '') ?? '';
    for (const order of result.orders) {
      if (!(await this.sessions.rememberOrder(sessionKey, orderSignature(order)))) {
        continue;
      }
      if (ownerNumber) {
        notifications.push({ to: ownerNumber, text: formatOrderForOwner(order) });
      } else {
        this.logger.log(
          { companyId, total: order.total, lines: order.items.length },
          'Pedido cerrado por WhatsApp (QR); el negocio no configuró número de avisos.',
        );
      }
    }
    return { reply: result.reply, notifications };
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > MAX_SEEN_MESSAGES) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
  }
}
