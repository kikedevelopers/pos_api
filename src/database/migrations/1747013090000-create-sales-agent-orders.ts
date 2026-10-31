import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — PEDIDOS que cierra el agente.
 *
 * Hasta ahora `close_order` solo le avisaba al dueño por el chat de avisos; el
 * pedido no quedaba en ningún lado. Esta tabla lo guarda para el informe
 * "Informes → Agente": allí el negocio ve los pedidos por tomar, con productos,
 * cliente, entrega, pago y canal, y los marca como tomados o descartados.
 *
 * NO es una venta ni un pedido (ORDER) del POS: es la bandeja de entrada del
 * agente. El negocio factura el pedido en el POS como siempre.
 *
 * Idempotencia: `operation_id` es el identificador del carrito que se cerró
 * (UUID). Un doble cierre del mismo carrito no crea dos pedidos.
 */
export class CreateSalesAgentOrders1747013090000 implements MigrationInterface {
  name = 'CreateSalesAgentOrders1747013090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "sales_agent_order_status" AS ENUM ('pending', 'taken', 'dismissed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sales_agent_orders" (
        "id" bigserial PRIMARY KEY,
        "company_id" bigint NOT NULL
          REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        "operation_id" uuid NOT NULL,
        "reference" varchar(16) NOT NULL,
        "status" "sales_agent_order_status" NOT NULL DEFAULT 'pending',
        "channel" varchar(32) NOT NULL,
        "channel_account" varchar(120) NULL,
        "chat_id" text NOT NULL,
        "chat_display_name" varchar(120) NULL,
        "chat_phone" varchar(40) NULL,
        "customer_name" varchar(120) NULL,
        "customer_phone" varchar(40) NULL,
        "delivery_mode" varchar(20) NOT NULL,
        "delivery_address" varchar(250) NULL,
        "payment_method" varchar(60) NULL,
        "notes" varchar(250) NULL,
        "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "items_count" integer NOT NULL DEFAULT 0,
        "total" numeric(14,2) NOT NULL DEFAULT 0,
        "status_note" varchar(250) NULL,
        "status_changed_at" timestamptz NULL,
        "status_changed_by_user_id" bigint NULL
          REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_sales_agent_orders_total" CHECK ("total" >= 0),
        CONSTRAINT "chk_sales_agent_orders_delivery_mode"
          CHECK ("delivery_mode" IN ('domicilio', 'recoger'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_sales_agent_orders_operation_unique"
        ON "sales_agent_orders" ("company_id", "operation_id")
    `);
    // Bandeja (por estado, lo más reciente primero) y conteo de pendientes.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sales_agent_orders_company_status_created"
        ON "sales_agent_orders" ("company_id", "status", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sales_agent_orders_company_created"
        ON "sales_agent_orders" ("company_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sales_agent_orders"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "sales_agent_order_status"`);
  }
}
