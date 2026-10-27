import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AiConfig } from '@/config/ai.config';

/**
 * Cliente del Files API de Google Gemini: sube UNA vez la foto o el PDF que
 * adjuntó el usuario y devuelve su URI, que luego se referencia en cada turno
 * del chat (`fileData`) sin volver a mandar los bytes. Google conserva el
 * archivo 48 h y lo borra solo.
 *
 * Protocolo (subida "resumable" de dos pasos, la documentada por Google):
 *   1. `POST {origin}/upload/v1beta/files` con `X-Goog-Upload-Command: start`
 *      → la respuesta trae la URL de subida en `x-goog-upload-url`.
 *   2. `POST` de los bytes a esa URL con `upload, finalize` → el `file`.
 *   3. Si el archivo quedó `PROCESSING`, se consulta hasta que esté `ACTIVE`.
 */

/** Archivo tal como lo describe Google. */
export interface GeminiUploadedFile {
  /** Nombre del recurso (`files/abc123`). */
  name: string;
  /** URI que se manda en `fileData.fileUri`. */
  uri: string;
  mimeType: string;
  /** `PROCESSING` → `ACTIVE` (listo) o `FAILED`; Google puede sumar otros. */
  state: string;
  /** Cuándo lo borra Google (ISO). */
  expirationTime?: string;
}

/** Error de la subida, con mensaje listo para el usuario. */
export class GeminiFileUploadError extends Error {
  constructor(
    message: string,
    /** 503 = servicio de Google no disponible / sin llave; 422 = archivo rechazado. */
    readonly status: 422 | 503,
  ) {
    super(message);
    this.name = 'GeminiFileUploadError';
  }
}

/** Espera máxima a que Google termine de procesar el archivo. */
export const FILE_ACTIVE_TIMEOUT_MS = 30_000;
const FILE_POLL_INTERVAL_MS = 1_000;

/**
 * URL de inicio de la subida: la API de subida vive en `/upload` sobre el
 * mismo origen y versión que la base configurada
 * (`https://generativelanguage.googleapis.com/v1beta` →
 * `https://generativelanguage.googleapis.com/upload/v1beta/files`).
 */
export const buildUploadStartUrl = (baseUrl: string, apiKey: string): string => {
  const base = new URL(baseUrl.replace(/\/+$/, ''));
  const path = base.pathname.replace(/\/+$/, '');
  return `${base.origin}/upload${path}/files?key=${encodeURIComponent(apiKey)}`;
};

/** URL para consultar el estado de un archivo ya subido (`files/abc123`). */
export const buildFileStatusUrl = (baseUrl: string, name: string, apiKey: string): string => {
  const cleanName = name.replace(/^\/+/, '');
  if (!/^files\/[A-Za-z0-9_-]+$/.test(cleanName)) {
    throw new GeminiFileUploadError('Google devolvió un archivo inválido.', 503);
  }
  return `${baseUrl.replace(/\/+$/, '')}/${cleanName}?key=${encodeURIComponent(apiKey)}`;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Lee el `file` de una respuesta de Google (`{ file: {...} }` al subir, el
 * objeto directo al consultar). `null` si le falta lo indispensable.
 */
export const parseUploadedFile = (payload: unknown): GeminiUploadedFile | null => {
  const root = asRecord(payload);
  const file = asRecord(root?.file) ?? root;
  if (!file) {
    return null;
  }
  const { name, uri, mimeType, state, expirationTime } = file;
  if (typeof name !== 'string' || typeof uri !== 'string' || uri.length === 0) {
    return null;
  }
  return {
    name,
    uri,
    mimeType: typeof mimeType === 'string' ? mimeType : '',
    state: typeof state === 'string' ? state : 'STATE_UNSPECIFIED',
    expirationTime: typeof expirationTime === 'string' ? expirationTime : undefined,
  };
};

const UNAVAILABLE_MESSAGE =
  'No se pudo preparar el archivo para Place en este momento. Intenta de nuevo en unos segundos.';

@Injectable()
export class GeminiFilesClient {
  private readonly logger = new Logger(GeminiFilesClient.name);

  constructor(private readonly configService: ConfigService) {}

  private get config(): AiConfig {
    return this.configService.getOrThrow<AiConfig>('ai');
  }

  /** Sube el archivo y espera a que Google lo deje `ACTIVE`. */
  async upload(params: {
    buffer: Buffer;
    mime_type: string;
    display_name: string;
  }): Promise<GeminiUploadedFile> {
    const { apiKey, baseUrl, requestTimeoutMs } = this.config;
    if (apiKey.length === 0) {
      throw new GeminiFileUploadError(
        'PlacePOS IA no está configurada en el servidor. Contacta al administrador.',
        503,
      );
    }
    const signal = AbortSignal.timeout(requestTimeoutMs);

    try {
      const start = await fetch(buildUploadStartUrl(baseUrl, apiKey), {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(params.buffer.length),
          'X-Goog-Upload-Header-Content-Type': params.mime_type,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: params.display_name } }),
        signal,
      });
      const upload_url = start.headers.get('x-goog-upload-url');
      if (!start.ok || !upload_url) {
        this.logger.error(
          { status: start.status, detail: (await start.text().catch(() => '')).slice(0, 500) },
          'Gemini Files API rechazó el inicio de la subida',
        );
        throw new GeminiFileUploadError(UNAVAILABLE_MESSAGE, 503);
      }

      const finish = await fetch(upload_url, {
        method: 'POST',
        headers: {
          'Content-Length': String(params.buffer.length),
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: new Uint8Array(params.buffer),
        signal,
      });
      const raw = await finish.text().catch(() => '');
      if (!finish.ok) {
        this.logger.error(
          { status: finish.status, detail: raw.slice(0, 500) },
          'Gemini Files API rechazó el archivo',
        );
        throw finish.status >= 400 && finish.status < 500
          ? new GeminiFileUploadError('Place no pudo leer este archivo. Prueba con otro.', 422)
          : new GeminiFileUploadError(UNAVAILABLE_MESSAGE, 503);
      }

      const file = parseUploadedFile(this.parseJson(raw));
      if (!file) {
        throw new GeminiFileUploadError(UNAVAILABLE_MESSAGE, 503);
      }
      return await this.waitUntilActive(file, signal);
    } catch (error) {
      if (error instanceof GeminiFileUploadError) {
        throw error;
      }
      this.logger.error({ err: error }, 'Fallo de transporte subiendo un archivo a Gemini');
      throw new GeminiFileUploadError(UNAVAILABLE_MESSAGE, 503);
    }
  }

  private async waitUntilActive(
    file: GeminiUploadedFile,
    signal: AbortSignal,
  ): Promise<GeminiUploadedFile> {
    const { apiKey, baseUrl } = this.config;
    const deadline = Date.now() + FILE_ACTIVE_TIMEOUT_MS;
    let current = file;
    while (current.state === 'PROCESSING') {
      if (Date.now() > deadline) {
        throw new GeminiFileUploadError(UNAVAILABLE_MESSAGE, 503);
      }
      await new Promise((resolve) => setTimeout(resolve, FILE_POLL_INTERVAL_MS));
      const response = await fetch(buildFileStatusUrl(baseUrl, current.name, apiKey), { signal });
      const next = response.ok
        ? parseUploadedFile(this.parseJson(await response.text().catch(() => '')))
        : null;
      if (!next) {
        throw new GeminiFileUploadError(UNAVAILABLE_MESSAGE, 503);
      }
      current = next;
    }
    if (current.state === 'FAILED') {
      throw new GeminiFileUploadError('Place no pudo leer este archivo. Prueba con otro.', 422);
    }
    return current;
  }

  private parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
