import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Índice de apoyo para `GET /pos-reports/sales`.
 *
 * --------------------------------------------------------------------------
 * Contexto
 * --------------------------------------------------------------------------
 *
 * La query de invoices del reporte de ventas
 * (`get-sales-report.action.ts`) deriva, por cada invoice, el conteo y los
 * `operation_type` de sus notas activas. Tras la optimización, esa derivación
 * se hace con una pre-agregación (CTE `note_agg`):
 *
 *   SELECT sale_invoice_id, COUNT(*), STRING_AGG(DISTINCT operation_type, ',')
 *   FROM credit_notes
 *   WHERE company_id = $1 AND is_deleted = false
 *   GROUP BY sale_invoice_id
 *
 * El índice existente `idx_credit_notes_company_sale_invoice
 * (company_id, sale_invoice_id)` NO es parcial y no incluye `operation_type`,
 * por lo que la agregación debe ir al heap a leer `is_deleted` y
 * `operation_type` fila por fila.
 *
 * --------------------------------------------------------------------------
 * Índice creado
 * --------------------------------------------------------------------------
 *
 *  `idx_credit_notes_sale_invoice_active`
 *    ON credit_notes (company_id, sale_invoice_id)
 *    INCLUDE (operation_type)
 *    WHERE is_deleted = false
 *
 *  - Parcial `WHERE is_deleted = false`: la pre-agregación (y las subqueries
 *    de los filtros `noteFilter`) solo miran notas activas. Reduce el tamaño
 *    del índice excluyendo notas anuladas.
 *  - `INCLUDE (operation_type)`: permite resolver `COUNT(*)` y
 *    `STRING_AGG(operation_type)` con un Index-Only Scan, sin tocar el heap.
 *  - Orden `(company_id, sale_invoice_id)`: company_id primero (regla
 *    multi-tenant), sale_invoice_id segundo para el GROUP BY / lookup por
 *    invoice.
 *
 * --------------------------------------------------------------------------
 * Estrategia zero-downtime
 * --------------------------------------------------------------------------
 *
 *  `CREATE INDEX CONCURRENTLY` (no bloquea escrituras) requiere correr fuera
 *  de transacción, por eso `transaction = false`. Mismo patrón que
 *  `1747010400000-add-cashier-aggregation-indexes`.
 */
export class AddSalesReportNotesIndex1747011200000 implements MigrationInterface {
  name = 'AddSalesReportNotesIndex1747011200000';

  // Necesario para `CREATE INDEX CONCURRENTLY` — no puede correr en una TX.
  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credit_notes_sale_invoice_active
      ON credit_notes (company_id, sale_invoice_id)
      INCLUDE (operation_type)
      WHERE is_deleted = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_credit_notes_sale_invoice_active`,
    );
  }
}
