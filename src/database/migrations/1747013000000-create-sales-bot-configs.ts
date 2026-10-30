import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `sales_bot_configs` — configuración del bot VENDEDOR (Place) por negocio y
 * canal. Convierte el bot de una config por variables de entorno (v1, un solo
 * negocio) a algo MULTI-TENANT: cada dueño configura su bot desde el menú
 * "Asistente de ventas".
 *
 * Invariantes (en la BD, no solo en el código):
 *   - UNIQUE(company_id, channel): una sola config por negocio y canal.
 *   - `bot_name` de máx. 60 caracteres (nombre con el que el bot se presenta).
 *   - El token de Telegram es SECRETO: se guarda aquí y nunca sale del servidor.
 */
export class CreateSalesBotConfigs1747013000000 implements MigrationInterface {
  name = 'CreateSalesBotConfigs1747013000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "sales_bot_personality" AS ENUM (
          'amable_profesional', 'directo_comercial', 'formal_corporativo'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sales_bot_configs" (
        "id"                     bigserial   PRIMARY KEY,
        "company_id"             bigint      NOT NULL,
        "channel"                varchar(16) NOT NULL DEFAULT 'telegram',
        "enabled"                boolean     NOT NULL DEFAULT false,
        "bot_name"               text        NOT NULL DEFAULT '',
        "personality"            "sales_bot_personality" NOT NULL DEFAULT 'amable_profesional',
        "telegram_token"         text        NULL,
        "telegram_bot_username"  text        NULL,
        "telegram_bot_id"        bigint      NULL,
        "owner_chat_id"          text        NULL,
        "created_at"             timestamptz NOT NULL DEFAULT now(),
        "updated_at"             timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_sales_bot_configs_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "chk_sales_bot_configs_bot_name_len" CHECK (length("bot_name") <= 60),
        CONSTRAINT "chk_sales_bot_configs_channel" CHECK ("channel" IN ('telegram', 'whatsapp'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_sales_bot_configs_company_channel_unique"
        ON "sales_bot_configs" ("company_id", "channel")
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "sales_bot_configs" IS
      'Config del bot vendedor (Place) por negocio y canal. telegram_token es secreto del servidor; nunca se devuelve al cliente.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sales_bot_configs"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "sales_bot_personality"`);
  }
}
