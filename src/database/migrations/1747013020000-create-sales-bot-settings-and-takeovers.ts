import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — dos tablas nuevas:
 *
 * 1) `sales_bot_settings`: ajustes de COMPORTAMIENTO del agente por negocio
 *    (aplican a todos los canales). Una fila por negocio. Hoy: la política de
 *    stock (`inform` = avisa que no hay existencias; `offer_always` = ofrece y
 *    vende sin mencionar el stock).
 *
 * 2) `sales_bot_takeovers`: chats donde un HUMANO tomó el control. Mientras
 *    `paused_until` esté en el futuro, el agente no responde en ese chat. Se
 *    guarda en BD (no en memoria) para que un reinicio/deploy no haga que el bot
 *    vuelva a meterse en una conversación que ya lleva una persona.
 */
export class CreateSalesBotSettingsAndTakeovers1747013020000 implements MigrationInterface {
  name = 'CreateSalesBotSettingsAndTakeovers1747013020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sales_bot_settings" (
        "id"           bigserial   PRIMARY KEY,
        "company_id"   bigint      NOT NULL,
        "stock_policy" varchar(32) NOT NULL DEFAULT 'inform',
        "created_at"   timestamptz NOT NULL DEFAULT now(),
        "updated_at"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_sales_bot_settings_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "chk_sales_bot_settings_stock_policy"
          CHECK ("stock_policy" IN ('inform', 'offer_always'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_sales_bot_settings_company_unique"
        ON "sales_bot_settings" ("company_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sales_bot_takeovers" (
        "id"           bigserial   PRIMARY KEY,
        "company_id"   bigint      NOT NULL,
        "channel"      varchar(16) NOT NULL,
        "chat_id"      text        NOT NULL,
        "paused_until" timestamptz NOT NULL,
        "created_at"   timestamptz NOT NULL DEFAULT now(),
        "updated_at"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_sales_bot_takeovers_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "chk_sales_bot_takeovers_chat_not_empty" CHECK (length(btrim("chat_id")) > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_sales_bot_takeovers_chat_unique"
        ON "sales_bot_takeovers" ("company_id", "channel", "chat_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sales_bot_takeovers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sales_bot_settings"`);
  }
}
