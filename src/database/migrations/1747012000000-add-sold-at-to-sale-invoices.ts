import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Contabilidad de caja: reconocer la venta el día en que ENTRA el dinero.
 *
 * --------------------------------------------------------------------------
 * Decisión de negocio
 * --------------------------------------------------------------------------
 * Una venta/pedido se reconoce (ventas del día, GANANCIA, costo, créditos
 * nuevos, notas del día) el día en que se REALIZA/COBRA — la fecha en que
 * entra el dinero — NO el día en que se creó el pedido. Un pedido creado ayer
 * y cobrado hoy debe contar en el "Resumen del día" de HOY (ventas + recaudo
 * cuadran) y en la ganancia de HOY. Paridad con placepos.
 *
 * --------------------------------------------------------------------------
 * Columna `sold_at`
 * --------------------------------------------------------------------------
 * `sold_at timestamptz NULL`: instante en que la factura se convirtió en venta
 * (se realizó/cobró).
 *   - Venta directa (ticket_type SALE al crear) → `sold_at = created_at`.
 *   - Conversión ORDER → SALE al cobrar → `sold_at = now()` (instrumentado en
 *     `ProcessPaymentAction`, dentro de la MISMA transacción del cobro).
 *   - Pedido que sigue ORDER → `sold_at` NULL (no aparece en los reportes de
 *     ventas, que filtran `ticket_type = 'SALE'`).
 *
 * Las agregaciones filtran/agrupan por `COALESCE(sold_at, created_at)` para
 * blindar filas legadas sin backfill.
 *
 * --------------------------------------------------------------------------
 * Backfill (idempotente)
 * --------------------------------------------------------------------------
 * Para las ventas SALE existentes, `sold_at` = instante del PRIMER pago vivo
 * (`MIN(sale_payments.created_at) WHERE is_voided = false`) — que aproxima el
 * instante de conversión ORDER → SALE — o `created_at` si no hay pagos (venta
 * 100% a crédito o legado sin pagos). Solo toca filas SALE con `sold_at IS
 * NULL`, así que re-ejecutarla no cambia nada (idempotente). Los pedidos ORDER
 * quedan en NULL.
 *
 * Índice de EXPRESIÓN `(company_id, COALESCE(sold_at, created_at))` para el
 * filtro de rango per-company de los reportes de ventas del día. Las
 * agregaciones filtran por `COALESCE(sold_at, created_at) BETWEEN ...`; un índice
 * plano sobre `(company_id, sold_at)` NO es sargable para ese predicado (el
 * planner no lo usa y cae a Seq Scan), así que se indexa la MISMA expresión.
 * Aditiva y backward-compatible; `synchronize:false`.
 */
export class AddSoldAtToSaleInvoices1747012000000 implements MigrationInterface {
  name = 'AddSoldAtToSaleInvoices1747012000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sale_invoices
      ADD COLUMN IF NOT EXISTS sold_at timestamptz
    `);

    // Backfill idempotente: solo ventas SALE aún sin sold_at.
    await queryRunner.query(`
      UPDATE sale_invoices si
      SET sold_at = COALESCE(
        (
          SELECT MIN(sp.created_at)
          FROM sale_payments sp
          WHERE sp.sale_invoice_id = si.id
            AND sp.is_voided = false
        ),
        si.created_at
      )
      WHERE si.ticket_type = 'SALE'
        AND si.sold_at IS NULL
    `);

    // Índice de EXPRESIÓN: las agregaciones filtran por
    // `COALESCE(sold_at, created_at) BETWEEN ...`. Un índice plano sobre
    // `(company_id, sold_at)` NO es sargable para ese predicado; se indexa la
    // misma expresión para que el planner haga Index Scan.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_sale_invoices_company_sold_at
      ON sale_invoices (company_id, COALESCE(sold_at, created_at))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sale_invoices_company_sold_at`);
    await queryRunner.query(`ALTER TABLE sale_invoices DROP COLUMN IF EXISTS sold_at`);
  }
}
