import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — el CLIENTE puede cambiar o cancelar su pedido.
 *
 * Mientras ninguna persona lo haya tomado (por tomar y sin ticket), el agente
 * actualiza el MISMO pedido o lo descarta por el cliente. Ya tomado, no lo
 * toca: deja la solicitud para el equipo.
 *   - `customer_updated_at`: última vez que el cliente lo modificó.
 *   - `cancelled_by_customer`: lo descartó el cliente (no el negocio).
 *   - `customer_request` / `customer_request_at`: solicitud del cliente sobre
 *     un pedido ya tomado (cambiar o cancelar), para que el equipo la atienda.
 */
export class AddCustomerChangesToSalesAgentOrders1747013120000 implements MigrationInterface {
  name = 'AddCustomerChangesToSalesAgentOrders1747013120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_agent_orders"
        ADD COLUMN IF NOT EXISTS "customer_updated_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "cancelled_by_customer" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "customer_request" varchar(500) NULL,
        ADD COLUMN IF NOT EXISTS "customer_request_at" timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_agent_orders"
        DROP COLUMN IF EXISTS "customer_request_at",
        DROP COLUMN IF EXISTS "customer_request",
        DROP COLUMN IF EXISTS "cancelled_by_customer",
        DROP COLUMN IF EXISTS "customer_updated_at"
    `);
  }
}
