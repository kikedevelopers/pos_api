import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Archivos (fotos y PDF) que el usuario le adjunta a Place.
 *
 * Los BYTES no se guardan aquí: se suben una sola vez al Files API de Google y
 * cada turno del chat los referencia por su `gemini_file_uri`. Esta tabla solo
 * guarda a QUIÉN pertenece cada archivo: los archivos del Files API son de la
 * llave del servidor (compartida por todos los negocios), así que el cliente
 * nunca manda la URI — manda el `id` y el servidor la resuelve filtrando por
 * company y usuario. Sin esto, un negocio podría leer la factura de otro.
 *
 *   - `expires_at` vence ANTES que el archivo en Google (48 h): un id vigente
 *     siempre apunta a un archivo que Google todavía tiene.
 *   - Las filas vencidas no se usan; se purgan al subir archivos nuevos.
 */
export class CreateAiAttachments1747012960000 implements MigrationInterface {
  name = 'CreateAiAttachments1747012960000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_attachments" (
        "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "company_id"       bigint      NOT NULL,
        "user_id"          bigint      NOT NULL,
        "file_name"        text        NOT NULL,
        "mime_type"        text        NOT NULL,
        "size_bytes"       integer     NOT NULL,
        "gemini_file_name" text        NOT NULL,
        "gemini_file_uri"  text        NOT NULL,
        "expires_at"       timestamptz NOT NULL,
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_ai_attachments_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "chk_ai_attachments_mime_type" CHECK ("mime_type" IN (
          'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'
        )),
        CONSTRAINT "chk_ai_attachments_size_positive" CHECK ("size_bytes" > 0),
        CONSTRAINT "chk_ai_attachments_file_name_not_empty" CHECK (length(btrim("file_name")) > 0),
        CONSTRAINT "chk_ai_attachments_expires_after_creation" CHECK ("expires_at" > "created_at")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ai_attachments_company_user"
        ON "ai_attachments" ("company_id", "user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ai_attachments_expires_at"
        ON "ai_attachments" ("expires_at")
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "ai_attachments" IS
      'Fotos y PDF adjuntados a Place: dueño (company/usuario) y referencia al Files API de Gemini. Sin bytes.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_attachments"`);
  }
}
