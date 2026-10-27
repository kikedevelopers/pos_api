import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  ATTACHMENT_TTL_HOURS,
  detectAttachmentMime,
  isAttachmentId,
  MAX_ATTACHMENT_BYTES,
  sanitizeAttachmentName,
  type ResolvedAttachment,
} from '../internal/attachments';
import {
  GeminiFilesClient,
  GeminiFileUploadError,
  type GeminiUploadedFile,
} from '../internal/gemini-files';

/** Archivo tal como lo entrega multer (solo lo que usamos). */
export interface UploadedAttachmentFile {
  originalname?: string;
  size?: number;
  buffer?: Buffer;
}

/** Lo que el cliente recibe y guarda en su historial (nunca la URI de Google). */
export interface AiAttachmentView {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  expires_at: string;
}

/** Google borra a las 48 h: el id vence al menos una hora antes. */
const GOOGLE_EXPIRY_MARGIN_MS = 60 * 60 * 1000;

/**
 * Vencimiento del adjunto: `ATTACHMENT_TTL_HOURS` desde ahora, pero nunca
 * después de una hora antes de que Google borre el archivo.
 */
export const attachmentExpiry = (now: Date, google_expiration?: string): Date => {
  const ttl = now.getTime() + ATTACHMENT_TTL_HOURS * 60 * 60 * 1000;
  const google = google_expiration ? Date.parse(google_expiration) : Number.NaN;
  if (Number.isNaN(google)) {
    return new Date(ttl);
  }
  return new Date(Math.min(ttl, google - GOOGLE_EXPIRY_MARGIN_MS));
};

const INSERT_ATTACHMENT_SQL = `
  INSERT INTO ai_attachments
    (company_id, user_id, file_name, mime_type, size_bytes, gemini_file_name, gemini_file_uri, expires_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  RETURNING id::text AS id, expires_at
`;

/** Adjuntos VIGENTES de ESTE usuario en ESTA company. Nunca los de otro. */
const RESOLVE_ATTACHMENTS_SQL = `
  SELECT id::text AS id, file_name, mime_type, gemini_file_uri
    FROM ai_attachments
   WHERE company_id = $1
     AND user_id = $2
     AND id = ANY($3::uuid[])
     AND expires_at > now()
`;

/** Limpieza oportunista: las filas vencidas ya no sirven para nada. */
const PURGE_EXPIRED_SQL = `DELETE FROM ai_attachments WHERE company_id = $1 AND expires_at <= now()`;

/**
 * Adjuntos de Place: sube la foto/PDF al Files API de Google UNA vez y guarda
 * a quién pertenece; luego resuelve los ids que manda el chat a sus URIs, solo
 * si son del mismo usuario y company y siguen vigentes.
 */
@Injectable()
export class AiAttachmentsAction {
  private readonly logger = new Logger(AiAttachmentsAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly geminiFiles: GeminiFilesClient,
  ) {}

  async upload(params: {
    company_id: number;
    user_id: number;
    file: UploadedAttachmentFile | undefined;
  }): Promise<AiAttachmentView> {
    const { company_id, user_id, file } = params;
    const buffer = file?.buffer;
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Adjunta una foto o un PDF.');
    }
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException(
        `El archivo supera el límite de ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`,
      );
    }
    const mime_type = detectAttachmentMime(buffer);
    if (!mime_type) {
      throw new UnprocessableEntityException(
        'Solo puedes adjuntar fotos (JPG, PNG, WebP o HEIC) o documentos PDF.',
      );
    }
    const file_name = sanitizeAttachmentName(file?.originalname, mime_type);

    let uploaded: GeminiUploadedFile;
    try {
      uploaded = await this.geminiFiles.upload({ buffer, mime_type, display_name: file_name });
    } catch (error) {
      if (error instanceof GeminiFileUploadError) {
        throw new HttpException(
          error.message,
          error.status === 422 ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw error;
    }

    const expires_at = attachmentExpiry(new Date(), uploaded.expirationTime);
    const [row] = await this.dataSource.query<Array<{ id: string; expires_at: Date }>>(
      INSERT_ATTACHMENT_SQL,
      [
        String(company_id),
        String(user_id),
        file_name,
        mime_type,
        buffer.length,
        uploaded.name,
        uploaded.uri,
        expires_at,
      ],
    );

    await this.dataSource.query(PURGE_EXPIRED_SQL, [String(company_id)]).catch((error: unknown) => {
      this.logger.warn({ err: error, companyId: company_id }, 'No se pudieron purgar adjuntos');
    });

    this.logger.log({
      event: 'ai.attachment.uploaded',
      companyId: company_id,
      userId: user_id,
      mimeType: mime_type,
      sizeBytes: buffer.length,
    });

    return {
      id: row.id,
      file_name,
      mime_type,
      size_bytes: buffer.length,
      expires_at: new Date(row.expires_at).toISOString(),
    };
  }

  /** Adjuntos vigentes del usuario, por id. Los ajenos/vencidos simplemente no aparecen. */
  async resolve(
    company_id: number,
    user_id: number,
    ids: readonly string[],
  ): Promise<Map<string, ResolvedAttachment>> {
    const valid = ids.filter(isAttachmentId);
    if (valid.length === 0) {
      return new Map();
    }
    const rows = await this.dataSource.query<ResolvedAttachment[]>(RESOLVE_ATTACHMENTS_SQL, [
      String(company_id),
      String(user_id),
      valid,
    ]);
    return new Map(rows.map((row) => [row.id.toLowerCase(), row]));
  }
}
