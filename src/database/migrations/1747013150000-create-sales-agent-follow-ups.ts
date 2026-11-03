import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — SEGUIMIENTOS a clientes.
 *
 * Desde Informes → Clientes, una persona pide al agente un saludo personal para
 * un cliente, lo revisa y lo envía por el WhatsApp del negocio (QR). Cada envío
 * queda aquí por dos razones:
 *   1. Auditoría: quién lo envió, a quién y qué productos recordó/sugirió.
 *   2. Contexto: cuando el cliente responde, el relay inyecta el mensaje en la
 *      conversación del agente (`context_attached_at`) para que siga la charla
 *      sabiendo qué le escribió. Se busca por chat o por número porque WhatsApp
 *      puede responder desde un chat `@lid` distinto al que se usó al enviar.
 */
export class CreateSalesAgentFollowUps1747013150000 implements MigrationInterface {
  name = 'CreateSalesAgentFollowUps1747013150000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sales_agent_follow_ups" (
        "id" bigserial PRIMARY KEY,
        "company_id" bigint NOT NULL,
        "customer_id" bigint NOT NULL,
        "channel" varchar(16) NOT NULL DEFAULT 'whatsapp-web',
        "chat_id" text NOT NULL,
        "phone" varchar(20) NOT NULL,
        "message" text NOT NULL,
        "recalled_product_ids" bigint[] NOT NULL DEFAULT '{}',
        "suggested_product_ids" bigint[] NOT NULL DEFAULT '{}',
        "sent_by_user_id" bigint NULL,
        "sent_by_name" text NULL,
        "context_attached_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_sales_agent_follow_ups_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies"("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "fk_sales_agent_follow_ups_customer_id" FOREIGN KEY ("customer_id")
          REFERENCES "customers"("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "chk_sales_agent_follow_ups_message_len"
          CHECK (length(btrim("message")) BETWEEN 1 AND 2000),
        CONSTRAINT "chk_sales_agent_follow_ups_phone_digits"
          CHECK ("phone" ~ '^[0-9]{7,20}$')
      )
    `);
    // Historial del cliente (último seguimiento primero).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sales_agent_follow_ups_customer"
        ON "sales_agent_follow_ups" ("company_id", "customer_id", "created_at" DESC)
    `);
    // El relay busca el seguimiento pendiente de contexto por número o por chat.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sales_agent_follow_ups_pending_phone"
        ON "sales_agent_follow_ups" ("company_id", "phone", "created_at" DESC)
        WHERE "context_attached_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sales_agent_follow_ups_pending_chat"
        ON "sales_agent_follow_ups" ("company_id", "chat_id", "created_at" DESC)
        WHERE "context_attached_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sales_agent_follow_ups"`);
  }
}
