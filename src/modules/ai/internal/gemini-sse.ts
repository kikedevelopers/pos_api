import type { GeminiFunctionCall, GeminiPart, GeminiStreamEvent } from './gemini.types';

/**
 * Parser del stream SSE de Gemini. Puro y por eso testeable: la parte impura
 * (leer el body HTTP) vive en `gemini-client.ts` y solo alimenta a estas
 * funciones.
 */

export interface SseSplitResult {
  /** Payloads `data:` completos, en orden de llegada. */
  data: string[];
  /** Lo que quedó a medias y debe concatenarse con el próximo chunk. */
  rest: string;
}

/**
 * Corta un buffer SSE en eventos completos. Un evento termina en línea en
 * blanco (`\n\n` o `\r\n\r\n`); todo lo que no llegó completo vuelve en `rest`.
 * Las líneas de comentario (`:`) y los campos que no son `data` se ignoran.
 */
export const splitSseEvents = (buffer: string): SseSplitResult => {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  // El último bloque solo está completo si el buffer terminaba en separador.
  const rest = blocks.pop() ?? '';

  const data: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const payload = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (payload.length > 0) {
      data.push(payload);
    }
  }

  return { data, rest };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Interpreta un payload `data:` del stream y extrae lo que nos importa: texto
 * visible, partes crudas (para reenviarlas), llamadas a herramientas, motivo de
 * corte y errores/bloqueos.
 *
 * Nunca lanza: un JSON corrupto devuelve un evento vacío. Un stream a medias no
 * puede tumbar la petición del usuario.
 */
export const parseGeminiEvent = (raw: string): GeminiStreamEvent => {
  const empty: GeminiStreamEvent = { text: '', parts: [], functionCalls: [] };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === '[DONE]') {
    return empty;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return empty;
  }

  const root = asRecord(parsed);
  if (!root) {
    return empty;
  }

  // Google manda los errores del stream como un objeto `error` normal.
  const error = asRecord(root.error);
  if (error) {
    const message = typeof error.message === 'string' ? error.message : 'Error del modelo.';
    return { ...empty, error: message };
  }

  const promptFeedback = asRecord(root.promptFeedback);
  const blockReason =
    promptFeedback && typeof promptFeedback.blockReason === 'string'
      ? promptFeedback.blockReason
      : undefined;

  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const candidate = asRecord(candidates[0]);
  if (!candidate) {
    return { ...empty, blockReason };
  }

  const finishReason =
    typeof candidate.finishReason === 'string' ? candidate.finishReason : undefined;

  const content = asRecord(candidate.content);
  const rawParts = content && Array.isArray(content.parts) ? content.parts : [];

  const parts: GeminiPart[] = [];
  const functionCalls: GeminiFunctionCall[] = [];
  let text = '';

  for (const rawPart of rawParts) {
    const part = asRecord(rawPart);
    if (!part) {
      continue;
    }
    parts.push(part);

    const call = asRecord(part.functionCall);
    if (call && typeof call.name === 'string') {
      functionCalls.push({
        name: call.name,
        args: asRecord(call.args) ?? {},
      });
    }

    // Las partes de razonamiento no se muestran: son el "pensamiento" interno.
    if (part.thought === true) {
      continue;
    }
    if (typeof part.text === 'string') {
      text += part.text;
    }
  }

  return { text, parts, functionCalls, finishReason, blockReason };
};

/**
 * Mensaje que explica al usuario por qué la respuesta se cortó, o `null` si
 * terminó normal. `STOP` y `FINISH_REASON_UNSPECIFIED` son finales sanos.
 */
export const describeFinishReason = (finishReason?: string): string | null => {
  switch (finishReason) {
    case undefined:
    case '':
    case 'STOP':
    case 'FINISH_REASON_UNSPECIFIED':
      return null;
    case 'MAX_TOKENS':
      return 'La respuesta quedó incompleta porque alcanzó el límite de longitud. Pide un resumen o divide la pregunta.';
    case 'SAFETY':
      return 'La respuesta fue bloqueada por los filtros de seguridad del modelo.';
    case 'RECITATION':
      return 'La respuesta fue bloqueada porque reproducía contenido protegido.';
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
      return 'La respuesta fue bloqueada por las políticas de contenido del modelo.';
    default:
      return `La generación terminó de forma inesperada (${finishReason}).`;
  }
};

/** Mensaje cuando el prompt del usuario fue bloqueado antes de generar. */
export const describeBlockReason = (blockReason?: string): string | null => {
  if (!blockReason) {
    return null;
  }
  if (blockReason === 'BLOCK_REASON_UNSPECIFIED') {
    return 'El modelo rechazó la solicitud sin dar un motivo.';
  }
  return 'Tu mensaje fue bloqueado por los filtros de seguridad del modelo. Reformúlalo e intenta de nuevo.';
};
