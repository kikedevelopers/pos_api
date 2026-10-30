import { Logger } from '@nestjs/common';

/** Mensaje entrante ya reducido a lo que nos importa. */
export interface TelegramIncomingMessage {
  updateId: number;
  chatId: string;
  text: string;
  /** Nombre visible del remitente (first_name + last_name o @username). */
  senderName?: string;
  /**
   * Telegram Business: id de la conexión cuando el mensaje llega por la cuenta
   * Business del dueño (el bot responde en su nombre). Se usa para responder.
   */
  businessConnectionId?: string;
  /**
   * Telegram Business: `true` si el mensaje lo escribió el LADO DEL NEGOCIO (no
   * el cliente). Junto con `sentByBot` permite detectar que un humano intervino.
   */
  fromBusinessSide?: boolean;
  /** Telegram Business: `true` si lo envió un bot en nombre del negocio (nosotros). */
  sentByBot?: boolean;
  /** Nota de voz / audio del cliente (se descarga con `downloadFile`). */
  voice?: { fileId: string; mimeType: string };
}

/** Archivo descargado de Telegram, en base64. */
export interface TelegramDownloadedFile {
  data: string;
}

/** Tope de descarga (bytes): la Bot API no sirve archivos de más de 20 MB. */
export const MAX_TELEGRAM_FILE_BYTES = 12 * 1024 * 1024;

/** Identidad del bot según `getMe` (lo que sí es público y podemos mostrar). */
export interface TelegramBotIdentity {
  id: string;
  username: string | null;
  firstName: string | null;
}

interface RawBotIdentity {
  id?: number;
  username?: string;
  first_name?: string;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface RawMessage {
  chat?: { id?: number | string };
  text?: string;
  from?: { id?: number | string; first_name?: string; last_name?: string; username?: string };
  business_connection_id?: string;
  sender_business_bot?: { id?: number };
  voice?: RawAudio;
  audio?: RawAudio;
}

interface RawAudio {
  file_id?: string;
  mime_type?: string;
  file_size?: number;
}

interface RawUpdate {
  update_id: number;
  message?: RawMessage;
  /** Mensaje de un chat de la cuenta Telegram Business conectada (ambos lados). */
  business_message?: RawMessage;
}

/**
 * Cliente mínimo de la Bot API de Telegram sobre `fetch`. Solo lo que usa el
 * vendedor: recibir mensajes (long-polling) y responder texto. El token vive
 * solo aquí (se inyecta desde la config del servidor).
 */
export class TelegramClient {
  private readonly logger = new Logger(TelegramClient.name);
  private readonly base: string;
  private readonly fileBase: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
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
   * Valida el token contra la Bot API (`getMe`). Devuelve la identidad del bot
   * si el token es válido, o `null` si Telegram lo rechaza o hay fallo de red.
   * Se usa para verificar el token ANTES de guardarlo (no arranca el poller).
   */
  async getMe(): Promise<TelegramBotIdentity | null> {
    const me = await this.call<RawBotIdentity>('getMe', {});
    if (!me || typeof me.id !== 'number') {
      return null;
    }
    return {
      id: String(me.id),
      username: me.username ?? null,
      firstName: me.first_name ?? null,
    };
  }

  /**
   * Trae los mensajes nuevos desde `offset` (long-poll en el lado de Telegram).
   * Incluye los chats normales con el bot (`message`) y los de la cuenta
   * Telegram Business conectada (`business_message`, de AMBOS lados: cliente y
   * negocio). Los updates que no atendemos vuelven con texto vacío para que el
   * poller avance el offset.
   */
  async getUpdates(offset: number, timeoutSec: number): Promise<TelegramIncomingMessage[]> {
    const updates = await this.call<RawUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'business_message'],
    });
    if (!updates) {
      return [];
    }

    return updates.map((update) => parseUpdate(update));
  }

  /**
   * Envía un mensaje de texto. Trocea si excede el límite de Telegram (4096).
   * Con `businessConnectionId` responde en nombre de la cuenta Business.
   */
  async sendMessage(chatId: string, text: string, businessConnectionId?: string): Promise<void> {
    for (const chunk of chunkText(text, 4000)) {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: chunk,
        ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {}),
      });
    }
  }

  /**
   * Descarga un archivo (p. ej. una nota de voz) por su `file_id`. Devuelve el
   * contenido en base64, o `null` si Telegram falla o el archivo es muy grande.
   */
  async downloadFile(fileId: string): Promise<TelegramDownloadedFile | null> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', {
      file_id: fileId,
    });
    if (!file?.file_path || (file.file_size ?? 0) > MAX_TELEGRAM_FILE_BYTES) {
      return null;
    }
    try {
      const response = await fetch(`${this.fileBase}/${file.file_path}`);
      if (!response.ok) {
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_TELEGRAM_FILE_BYTES) {
        return null;
      }
      return { data: buffer.toString('base64') };
    } catch (error) {
      this.logger.error({ err: error }, 'Fallo descargando un archivo de Telegram');
      return null;
    }
  }

  /** Muestra "escribiendo…" mientras el vendedor piensa. */
  async sendTyping(chatId: string, businessConnectionId?: string): Promise<void> {
    await this.call('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
      ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {}),
    });
  }
}

/**
 * Normaliza un update. En un chat Business privado, `chat.id` es el CLIENTE;
 * si `from.id` es distinto, el mensaje salió del lado del negocio (el dueño o
 * un bot en su nombre — este último trae `sender_business_bot`).
 */
const parseUpdate = (update: RawUpdate): TelegramIncomingMessage => {
  const business = update.business_message;
  const message = update.message ?? business;
  const chatId = message?.chat?.id;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const rawAudio = message?.voice ?? message?.audio;
  const voice = rawAudio?.file_id
    ? { fileId: rawAudio.file_id, mimeType: rawAudio.mime_type || 'audio/ogg' }
    : undefined;
  const base: TelegramIncomingMessage = {
    updateId: update.update_id,
    chatId: chatId === undefined || chatId === null ? '' : String(chatId),
    text,
    ...(voice ? { voice } : {}),
  };

  if (business && base.chatId) {
    const fromId = business.from?.id;
    const fromBusinessSide = fromId !== undefined && String(fromId) !== base.chatId;
    return {
      ...base,
      businessConnectionId: business.business_connection_id,
      fromBusinessSide,
      sentByBot: Boolean(business.sender_business_bot),
      ...(fromBusinessSide || (!text && !voice)
        ? {}
        : { senderName: buildSenderName(business.from) }),
    };
  }

  if (!base.chatId || (!text && !voice)) {
    // Stickers, fotos, etc.: sin texto, solo para avanzar el offset.
    return { updateId: base.updateId, chatId: base.chatId, text: '' };
  }
  return { ...base, senderName: buildSenderName(message?.from) };
};

const buildSenderName = (from?: {
  first_name?: string;
  last_name?: string;
  username?: string;
}): string | undefined => {
  if (!from) {
    return undefined;
  }
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return full || (from.username ? `@${from.username}` : undefined);
};

/** Trocea un texto largo en partes que quepan en un mensaje de Telegram. */
export const chunkText = (text: string, max: number): string[] => {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed.length > 0 ? [trimmed] : [];
  }
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    // Corta en el último salto de línea antes del límite para no partir palabras.
    const slice = rest.slice(0, max);
    const cut = slice.lastIndexOf('\n') > max * 0.5 ? slice.lastIndexOf('\n') : max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
};
