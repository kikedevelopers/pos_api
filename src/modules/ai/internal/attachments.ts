import type { ChatTurn, GeminiPart } from './gemini.types';

/**
 * Archivos (fotos y PDF) que el usuario le adjunta a Place. Puro y testeado:
 * qué se acepta, cómo se nombra y cómo viaja cada archivo dentro del historial
 * que se le manda a Gemini.
 *
 * Los bytes viven en el Files API de Google (subidos UNA vez); en cada turno
 * solo viaja su URI. El cliente nunca manda la URI: manda el `id` de
 * `ai_attachments` y el servidor la resuelve filtrando por company y usuario.
 */

/** Tipos que Gemini lee y que el negocio necesita: fotos de facturas y PDF. */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;

export type AttachmentMime = (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

/** Tope por archivo. Una factura escaneada pesa mucho menos. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/** Archivos por mensaje del usuario. */
export const MAX_ATTACHMENTS_PER_TURN = 5;

/**
 * Archivos que se le vuelven a mostrar al modelo en una misma pregunta (los
 * más recientes). Cada uno cuesta tokens en CADA turno; los más viejos se
 * mencionan sin reenviarse.
 */
export const MAX_ATTACHMENTS_PER_REQUEST = 8;

/**
 * Vigencia de un adjunto. Google borra el archivo a las 48 h: el id vence
 * antes, así un id vigente nunca apunta a un archivo que ya no existe.
 */
export const ATTACHMENT_TTL_HOURS = 47;

/** Largo máximo del nombre que se guarda y se le muestra al modelo. */
export const MAX_ATTACHMENT_NAME_LENGTH = 120;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isAttachmentId = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value);

/** Marcas de contenedor ISO-BMFF (`ftyp`) que identifican HEIC/HEIF. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

/**
 * Tipo REAL del archivo leyendo sus primeros bytes. El `Content-Type` del
 * multipart lo escribe el cliente y se puede falsear; la cabecera del binario
 * no. `null` = no es una foto ni un PDF.
 */
export const detectAttachmentMime = (buffer: Buffer): AttachmentMime | null => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  if (buffer.toString('ascii', 0, 5) === '%PDF-') {
    return 'application/pdf';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)) {
    return 'image/png';
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    if (HEIC_BRANDS.has(brand)) {
      return 'image/heic';
    }
    if (HEIF_BRANDS.has(brand)) {
      return 'image/heif';
    }
  }
  return null;
};

/** Nombre por defecto según el tipo, cuando el cliente no manda uno usable. */
const DEFAULT_NAMES: Record<AttachmentMime, string> = {
  'image/jpeg': 'foto.jpg',
  'image/png': 'imagen.png',
  'image/webp': 'imagen.webp',
  'image/heic': 'foto.heic',
  'image/heif': 'foto.heif',
  'application/pdf': 'documento.pdf',
};

/**
 * Nombre legible y seguro: sin rutas, sin caracteres de control y acotado. El
 * nombre llega al prompt, así que se recorta a algo inofensivo.
 */
export const sanitizeAttachmentName = (raw: unknown, mime: AttachmentMime): string => {
  const base =
    typeof raw === 'string'
      ? (raw.split(/[\\/]/).pop() ?? '')
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f«»[\]]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
  if (base.length === 0) {
    return DEFAULT_NAMES[mime];
  }
  return base.length > MAX_ATTACHMENT_NAME_LENGTH
    ? base.slice(base.length - MAX_ATTACHMENT_NAME_LENGTH)
    : base;
};

/** Ids válidos y sin repetir de un turno (los inválidos se ignoran). */
export const turnAttachmentIds = (turn: ChatTurn): string[] => {
  const raw = Array.isArray(turn?.attachment_ids) ? turn.attachment_ids : [];
  return [...new Set(raw.filter(isAttachmentId).map((id) => id.toLowerCase()))].slice(
    0,
    MAX_ATTACHMENTS_PER_TURN,
  );
};

/**
 * Todos los ids del historial (del más viejo al más nuevo) y cuáles se
 * reenvían de verdad: los `MAX_ATTACHMENTS_PER_REQUEST` más recientes.
 */
export const collectAttachmentIds = (
  turns: readonly ChatTurn[],
): { all: string[]; included: Set<string> } => {
  const all: string[] = [];
  const list: readonly ChatTurn[] = Array.isArray(turns) ? turns : [];
  for (const turn of list) {
    if (turn?.role !== 'user') {
      continue;
    }
    for (const id of turnAttachmentIds(turn)) {
      if (!all.includes(id)) {
        all.push(id);
      }
    }
  }
  return { all, included: new Set(all.slice(-MAX_ATTACHMENTS_PER_REQUEST)) };
};

/** Texto que ocupa el lugar del mensaje cuando el usuario solo adjuntó archivos. */
export const attachmentOnlyText = (count: number): string =>
  count === 1 ? '(Adjunté un archivo)' : `(Adjunté ${count} archivos)`;

/**
 * Un mensaje con solo adjuntos (sin texto) se vuelve "(Adjunté un archivo)":
 * el resto del módulo (historial, confirmaciones) trabaja con texto y
 * descartaría un turno vacío. Es determinista: el mismo turno produce siempre
 * el mismo texto, así las confirmaciones (hash del mensaje) siguen cuadrando.
 */
export const normalizeAttachmentTurns = (turns: readonly ChatTurn[]): ChatTurn[] => {
  const list: readonly ChatTurn[] = Array.isArray(turns) ? turns : [];
  return list.map((turn): ChatTurn => {
    if (turn?.role !== 'user') {
      return turn;
    }
    const ids = turnAttachmentIds(turn);
    const content = typeof turn.content === 'string' ? turn.content : '';
    if (ids.length === 0 || content.trim().length > 0) {
      return turn;
    }
    return { ...turn, content: attachmentOnlyText(ids.length) };
  });
};

/** Lo que el servidor sabe de un adjunto vigente del usuario. */
export interface ResolvedAttachment {
  id: string;
  file_name: string;
  mime_type: string;
  gemini_file_uri: string;
}

/**
 * Partes de Gemini que acompañan a un turno del usuario, ANTES de su texto:
 *   - vigente y reciente → etiqueta con el nombre + el archivo (`fileData`);
 *   - vigente pero viejo → solo la mención (no se reenvía);
 *   - vencido o ajeno    → aviso de que ya no está (nunca se revela por qué:
 *     un id de otro negocio se ve igual que uno vencido).
 */
export const buildAttachmentPartsResolver = (
  resolved: ReadonlyMap<string, ResolvedAttachment>,
  included: ReadonlySet<string>,
): ((turn: ChatTurn) => GeminiPart[]) => {
  return (turn) => {
    if (turn?.role !== 'user') {
      return [];
    }
    const parts: GeminiPart[] = [];
    for (const id of turnAttachmentIds(turn)) {
      const attachment = resolved.get(id);
      if (!attachment) {
        parts.push({
          text: '[Archivo adjunto que ya no está disponible: los archivos se conservan 47 horas. Si lo necesitas, pídele al usuario que lo adjunte de nuevo.]',
        });
        continue;
      }
      if (!included.has(id)) {
        parts.push({
          text: `[Archivo «${attachment.file_name}» adjuntado antes en la conversación; ya no se te reenvía. Si lo necesitas, pídele al usuario que lo adjunte de nuevo.]`,
        });
        continue;
      }
      parts.push({ text: `[Archivo adjunto: «${attachment.file_name}»]` });
      parts.push({
        fileData: { mimeType: attachment.mime_type, fileUri: attachment.gemini_file_uri },
      });
    }
    return parts;
  };
};
