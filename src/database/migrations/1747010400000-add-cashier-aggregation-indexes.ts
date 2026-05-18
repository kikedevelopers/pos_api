import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Riesgo 1 — Índices compuestos para el endpoint
 * `GET /dashboard/today-by-cashier`.
 *
 * --------------------------------------------------------------------------
 * Contexto
 * --------------------------------------------------------------------------
 *
 * El módulo `dashboard/internal/cashier-aggregations.ts` ejecuta 7 queries
 * paralelas que agregan ventas, pagos, notas y créditos por
 * `(company_id, created_by_id, created_at BETWEEN ...)`. Sin índices
 * compuestos, cada query degenera en seq scan + filter + sort sobre la
 * tabla completa. Con >100k filas el latency es inaceptable.
 *
 * --------------------------------------------------------------------------
 * Índices creados
 * --------------------------------------------------------------------------
 *
 *  1. `idx_sale_invoices_company_creator_date`
 *     ON sale_invoices (company_id, created_by_id, created_at)
 *     WHERE is_deleted = false
 *
 *     Cubre:
 *       - fetchSalesByCashier      (JOIN inicial sobre sale_invoices)
 *       - fetchSalesProfitByCashier
 *       - fetchSalesCountByCashier
 *       - fetchNewCreditsByCashier (JOIN sobre si)
 *
 *     `is_deleted = false` es índice parcial: todas las queries del módulo
 *     filtran sólo invoices activas. El predicado reduce el tamaño del
 *     índice ~10-20 % al excluir invoices anuladas.
 *
 *  2. `idx_sale_payments_company_creator_date`
 *     ON sale_payments (company_id, created_by_id, created_at)
 *
 *     Cubre:
 *       - fetchAbonosByCashier (filtra por sp.created_by_id + sp.created_at)
 *       - fetchCreditPaymentsProfitShareByCashier
 *       - fetchSalesByCashier (join sale_payments → sale_invoices, aunque
 *         el driver puede preferir el otro extremo del join)
 *
 *     `sale_payments` no tiene `is_deleted` (los pagos no se borran lógico —
 *     reembolsos generan un movimiento nuevo). Índice total.
 *
 *  3. `idx_credit_notes_company_creator_date`
 *     ON credit_notes (company_id, created_by_id, created_at)
 *     WHERE is_deleted = false
 *
 *     Cubre:
 *       - fetchNotesByCashier (filtro inicial sobre credit_notes)
 *
 *     Las notas anuladas no aportan al recaudo del día — filtro parcial OK.
 *
 *  4. `sale_credits` — OMITIDO INTENCIONAL.
 *     La tabla `sale_credits` NO tiene columna `created_by_id` (creada en
 *     migración 1747009440000). En PlacePos el credit hereda el actor del
 *     `sale_invoice` asociado, no lo persiste. La query
 *     `fetchNewCreditsByCashier` ya joinea contra `sale_invoices` y agrupa
 *     por `si.created_by_id` — el índice del punto (1) la cubre.
 *
 *     Si en el futuro `sale_credits` añade `created_by_id`, se debe crear
 *     `idx_sale_credits_company_creator_date` en una migración aparte.
 *
 * --------------------------------------------------------------------------
 * Orden de columnas
 * --------------------------------------------------------------------------
 *
 *  `(company_id, created_by_id, created_at)`: `company_id` primero por la
 *  regla multi-tenant (todas las queries empiezan por `WHERE company_id`),
 *  `created_by_id` segundo por igualdad (`GROUP BY` + filtro implícito),
 *  `created_at` tercero por rango (`BETWEEN`). Postgres puede usar el
 *  prefijo `(company_id, created_by_id)` para `GROUP BY` también.
 *
 * --------------------------------------------------------------------------
 * Estrategia zero-downtime en producción
 * --------------------------------------------------------------------------
 *
 *  Las tablas pueden tener muchas filas. `CREATE INDEX CONCURRENTLY` evita
 *  bloquear escrituras durante la creación, pero NO puede correr dentro de
 *  una transacción. TypeORM envuelve cada migración en TX por defecto.
 *
 *  Para activar CONCURRENTLY, declaramos `transaction = false` en la
 *  clase. Esto deshabilita la TX implícita; cada `queryRunner.query` corre
 *  en su propio statement. El trade-off: si una sentencia falla a mitad de
 *  camino, hay que limpiar a mano (los `IF NOT EXISTS` ayudan a reanudar).
 *
 *  Nota: con `CONCURRENTLY`, si Postgres detecta una transacción abierta,
 *  falla con "CREATE INDEX CONCURRENTLY cannot run inside a transaction
 *  block". Si en algún entorno no se honra `transaction = false`, basta
 *  con cambiar a `CREATE INDEX` clásico.
 */
export class AddCashierAggregationIndexes1747010400000 implements MigrationInterface {
  name = 'AddCashierAggregationIndexes1747010400000';

  // Necesario para `CREATE INDEX CONCURRENTLY` — no puede correr en una TX.
  public transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. sale_invoices — cubre fetchSales*, fetchSalesCount*, fetchNewCredits*.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sale_invoices_company_creator_date
      ON sale_invoices (company_id, created_by_id, created_at)
      WHERE is_deleted = false
    `);

    // 2. sale_payments — cubre fetchAbonos*, fetchCreditPaymentsProfit*.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sale_payments_company_creator_date
      ON sale_payments (company_id, created_by_id, created_at)
    `);

    // 3. credit_notes — cubre fetchNotesByCashier.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_credit_notes_company_creator_date
      ON credit_notes (company_id, created_by_id, created_at)
      WHERE is_deleted = false
    `);

    // sale_credits — omitido (la tabla no tiene created_by_id, ver JSDoc).
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_credit_notes_company_creator_date`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_sale_payments_company_creator_date`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS idx_sale_invoices_company_creator_date`,
    );
  }
}
