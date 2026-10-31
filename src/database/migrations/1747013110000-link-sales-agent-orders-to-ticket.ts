import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente de ventas — enlace del pedido del agente con el TICKET del POS.
 *
 * Desde el informe "Agente", "Llevar al POS" carga el pedido en el carrito; al
 * registrarlo, el POS lo enlaza con el ticket (`sale_invoice_id`) y el pedido
 * queda tomado. El consecutivo se lee del ticket (PED-x mientras sea pedido,
 * VTA-x al cobrarse), así siempre muestra el vigente.
 *
 * Un ticket corresponde a un solo pedido del agente (índice único parcial). Si
 * el ticket se borra, el enlace queda en NULL.
 */
export class LinkSalesAgentOrdersToTicket1747013110000 implements MigrationInterface {
  name = 'LinkSalesAgentOrdersToTicket1747013110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sales_agent_orders"
        ADD COLUMN IF NOT EXISTS "sale_invoice_id" bigint NULL
          REFERENCES "sale_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_sales_agent_orders_sale_invoice_unique"
        ON "sales_agent_orders" ("sale_invoice_id")
        WHERE "sale_invoice_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_sales_agent_orders_sale_invoice_unique"`);
    await queryRunner.query(`ALTER TABLE "sales_agent_orders" DROP COLUMN IF EXISTS "sale_invoice_id"`);
  }
}
