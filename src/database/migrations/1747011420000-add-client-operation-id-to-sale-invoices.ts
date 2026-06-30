import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Idempotencia en la CREACIÓN de ventas — evita facturas duplicadas por
 * doble-click / reintento de red en `POST /sales`.
 *
 * --------------------------------------------------------------------------
 * Problema
 * --------------------------------------------------------------------------
 * `createOrder` (PlacePos) y `POST /sales` (cloud) insertaban una factura nueva
 * en cada request: no había guard de idempotencia en la creación (solo en los
 * pagos vía `sale_payments.uuid` y en las ediciones). En cloud, la latencia de
 * red deja pasar dos requests antes de que el primero responda → dos facturas
 * idénticas para el mismo pedido.
 *
 * --------------------------------------------------------------------------
 * Solución
 * --------------------------------------------------------------------------
 *  - `client_operation_id text NULL`: UUID v4 que el cliente genera UNA vez por
 *    intento de registro y reusa en reintentos.
 *  - Índice único PARCIAL `(company_id, client_operation_id)` WHERE NOT NULL:
 *    hace FÍSICAMENTE imposible registrar la misma venta dos veces en una
 *    company, incluso bajo carrera. El `CreateSaleAction` hace fast-path de
 *    replay y recupera la venta ganadora si dos requests compiten.
 *
 * Parcial (WHERE client_operation_id IS NOT NULL): las ventas legadas / creadas
 * sin llave quedan con NULL y NO entran al índice (varios NULL no colisionan).
 */
export class AddClientOperationIdToSaleInvoices1747011420000 implements MigrationInterface {
  name = 'AddClientOperationIdToSaleInvoices1747011420000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sale_invoices
      ADD COLUMN IF NOT EXISTS client_operation_id text
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_invoices_client_operation
      ON sale_invoices (company_id, client_operation_id)
      WHERE client_operation_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_sale_invoices_client_operation`);
    await queryRunner.query(`ALTER TABLE sale_invoices DROP COLUMN IF EXISTS client_operation_id`);
  }
}
