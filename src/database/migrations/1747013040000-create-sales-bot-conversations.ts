import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — memoria de conversación PERSISTIDA (`sales_bot_conversations`).
 *
 * Antes vivía en RAM: cada reinicio/deploy del servidor borraba el historial y
 * el día del último mensaje, y el agente volvía a saludar y presentarse a mitad
 * de una conversación (y olvidaba lo hablado). Una fila por chat de cada canal.
 *
 * - `turns`: últimos turnos (cliente + vendedor) en JSON.
 * - `last_day`: día (Colombia) del último mensaje del cliente → saludo 1 vez al día.
 * - `order_signatures`: pedidos ya cerrados (red anti doble cierre).
 */
export class CreateSalesBotConversations1747013040000 implements MigrationInterface {
  name = 'CreateSalesBotConversations1747013040000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sales_bot_conversations" (
        "id"               bigserial   PRIMARY KEY,
        "company_id"       bigint      NOT NULL,
        "channel"          varchar(32) NOT NULL,
        "chat_id"          text        NOT NULL,
        "turns"            jsonb       NOT NULL DEFAULT '[]'::jsonb,
        "last_day"         varchar(10) NULL,
        "order_signatures" jsonb       NOT NULL DEFAULT '[]'::jsonb,
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_sales_bot_conversations_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "chk_sales_bot_conversations_chat_not_empty" CHECK (length(btrim("chat_id")) > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_sales_bot_conversations_chat_unique"
        ON "sales_bot_conversations" ("company_id", "channel", "chat_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sales_bot_conversations"`);
  }
}
