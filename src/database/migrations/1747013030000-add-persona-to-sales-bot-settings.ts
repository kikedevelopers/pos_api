import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — la PERSONA del agente (nombre + personalidad) pasa a los
 * ajustes por negocio (`sales_bot_settings`): el agente debe comportarse igual
 * en todos los canales, así que deja de configurarse por canal.
 *
 * Backfill desde `sales_bot_configs` (las columnas viejas se conservan por
 * compatibilidad con clientes anteriores): por negocio, gana la fila con nombre
 * no vacío, luego la de Telegram y luego la más reciente.
 */
export class AddPersonaToSalesBotSettings1747013030000 implements MigrationInterface {
  name = 'AddPersonaToSalesBotSettings1747013030000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings"
        ADD COLUMN IF NOT EXISTS "bot_name" text NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS "personality" "sales_bot_personality" NOT NULL DEFAULT 'amable_profesional'
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sales_bot_settings"
          ADD CONSTRAINT "chk_sales_bot_settings_bot_name_len" CHECK (length("bot_name") <= 60);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await queryRunner.query(`
      INSERT INTO "sales_bot_settings" ("company_id", "bot_name", "personality")
      SELECT DISTINCT ON (c."company_id")
             c."company_id", btrim(c."bot_name"), c."personality"
        FROM "sales_bot_configs" c
       ORDER BY c."company_id",
                (btrim(c."bot_name") <> '') DESC,
                (c."channel" = 'telegram') DESC,
                c."updated_at" DESC
      ON CONFLICT ("company_id") DO UPDATE
        SET "bot_name"    = EXCLUDED."bot_name",
            "personality" = EXCLUDED."personality",
            "updated_at"  = now()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_bot_settings"
        DROP CONSTRAINT IF EXISTS "chk_sales_bot_settings_bot_name_len",
        DROP COLUMN IF EXISTS "personality",
        DROP COLUMN IF EXISTS "bot_name"
    `);
  }
}
