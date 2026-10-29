import { Logger } from '@nestjs/common';

/** Mensaje entrante ya reducido a lo que nos importa. */
export interface TelegramIncomingMessage {
  updateId: number;
  chatId: string;
  text: string;
  /** Nombre visible del remitente (first_name + last_name o @username). */
  senderName?: string;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface RawUpdate {
  update_id: number;
  message?: {
    chat?: { id?: number | string };
    text?: string;
    from?: { first_name?: string; last_name?: string; username?: string };
  };
}

/**
 * Cliente mínimo de la Bot API de Telegram sobre `fetch`. Solo lo que usa el
 * vendedor: recibir mensajes (long-polling) y responder texto. El token vive
 * solo aquí (se inyecta desde la config del servidor).
 */
export class TelegramClient {
  private readonly logger = new Logger(TelegramClient.name);
  private readonly base: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
    try {
      const response = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as TelegramApiResponse<T>;
      if (!data.ok) {
        this.logger.warn(
          { method, code: data.error_code, description: data.description },
          'Telegram respondió con error',
        );
        return null;
      }
      return data.result ?? null;
    } catch (error) {
      this.logger.error({ err: error, method }, 'Fallo de red hablando con Telegram');
      return null;
    }
  }

  /**
   * Trae los mensajes nuevos desde `offset` (long-poll en el lado de Telegram).
   * Devuelve solo mensajes de texto, ya normalizados.
   */
  async getUpdates(offset: number, timeoutSec: number): Promise<TelegramIncomingMessage[]> {
    const updates = await this.call<RawUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message'],
    });
    if (!updates) return [];

    const messages: TelegramIncomingMessage[] = [];
    for (const update of updates) {
      const message = update.message;
      const chatId = message?.chat?.id;
      const text = message?.text;
      if (chatId === undefined || chatId === null || typeof text !== 'string' || !text.trim()) {
        // Igual avanzamos el offset de los updates que no atendemos (stickers,
        // fotos, etc.) devolviéndolos sin texto NO: el offset lo lleva el poller
        // con el update_id más alto visto, así que basta registrarlo abajo.
        messages.push({ updateId: update.update_id, chatId: String(chatId ?? ''), text: '' });
        continue;
      }
      messages.push({
        updateId: update.update_id,
        chatId: String(chatId),
        text: text.trim(),
        senderName: buildSenderName(message?.from),
      });
    }
    return messages;
  }

  /** Envía un mensaje de texto. Trocea si excede el límite de Telegram (4096). */
  async sendMessage(chatId: string, text: string): Promise<void> {
    for (const chunk of chunkText(text, 4000)) {
      await this.call('sendMessage', { chat_id: chatId, text: chunk });
    }
  }

  /** Muestra "escribiendo…" mientras el vendedor piensa. */
  async sendTyping(chatId: string): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing' });
  }
}

const buildSenderName = (from?: {
  first_name?: string;
  last_name?: string;
  username?: string;
}): string | undefined => {
  if (!from) return undefined;
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return full || (from.username ? `@${from.username}` : undefined);
};

/** Trocea un texto largo en partes que quepan en un mensaje de Telegram. */
export const chunkText = (text: string, max: number): string[] => {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed.length > 0 ? [trimmed] : [];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    // Corta en el último salto de línea antes del límite para no partir palabras.
    const slice = rest.slice(0, max);
    const cut = slice.lastIndexOf('\n') > max * 0.5 ? slice.lastIndexOf('\n') : max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
};
