import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fuente ÚNICA de la verdad para "venta consolidada" (venta ± sus notas).
 *
 * --------------------------------------------------------------------------
 * Por qué existe
 * --------------------------------------------------------------------------
 *
 * La regla del negocio es una sola: la nota crédito RESTA y la nota débito SUMA,
 * y todo informe que cuente ventas debe usar el consolidado. Pero la regla
 * estaba escrita a mano en una docena de consultas distintas, y cada copia se
 * equivocó a su manera:
 *
 *   - unir `credit_note_lines` antes de sumar → la nota se restaba una vez por
 *     cada línea que tuviera;
 *   - excluir la venta anulada pero NO su nota → la nota se restaba dos veces;
 *   - consolidar el total pero no el costo → ganancia inflada;
 *   - agrupar por nombre de producto → la nota se aplicaba una vez por cada
 *     nombre histórico.
 *
 * El resultado: el mismo día valía distinto según la pantalla. Estas vistas
 * escriben la regla UNA vez para que ningún informe tenga que volver a
 * deducirla.
 *
 * --------------------------------------------------------------------------
 * Decisiones de diseño
 * --------------------------------------------------------------------------
 *
 * 1. Son vistas NORMALES, no materializadas: no duplican datos, no hay nada que
 *    refrescar y no pueden quedar desactualizadas. Cuestan milisegundos porque
 *    se apoyan en los índices que ya existen.
 * 2. NO filtran `ticket_type` ni `is_deleted`: los exponen. Quien consulta
 *    decide, porque el flag `include_orders_in_reports` hace que a veces los
 *    pedidos cuenten y a veces no, y porque hay informes que necesitan listar
 *    las anuladas. Lo que la vista garantiza es que al excluir una venta se
 *    excluye TAMBIÉN su nota: es imposible volver a restar la nota de una venta
 *    que no se contó.
 * 3. El ajuste se agrega por factura ANTES de unirse: nunca se multiplica por
 *    líneas ni por pagos.
 * 4. Las notas anuladas (`credit_notes.is_deleted`) no ajustan nada.
 * 5. `company_id` viaja en todas las vistas: el aislamiento entre tenants sigue
 *    siendo responsabilidad de quien consulta, igual que con las tablas.
 *
 * Revertir es `DROP VIEW`: no toca datos.
 */
export class AddConsolidatedSalesViews1747012360000 implements MigrationInterface {
  name = 'AddConsolidatedSalesViews1747012360000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Ajuste por factura ────────────────────────────────────────────────
    // El total y el costo que las notas de una venta suman o restan, ya
    // agregados. `total_adjustment` viene CON SIGNO: la de crédito resta.
    await queryRunner.query(`
      CREATE OR REPLACE VIEW "v_sale_note_adjustments" AS
      SELECT
        cn.company_id,
        cn.sale_invoice_id,
        SUM(CASE WHEN cn.note_type = 'DEBIT' THEN cn.total ELSE -cn.total END)          AS total_adjustment,
        SUM(CASE WHEN cn.note_type = 'DEBIT' THEN cn_cost.cost ELSE -cn_cost.cost END)  AS cost_adjustment,
        COUNT(*)                                                                        AS notes_count,
        COUNT(*) FILTER (WHERE cn.note_type = 'CREDIT')                                 AS credit_notes_count,
        COUNT(*) FILTER (WHERE cn.note_type = 'DEBIT')                                  AS debit_notes_count,
        BOOL_OR(cn.operation_type = 'FULL_VOID')                                        AS has_full_void,
        MAX(cn.created_at)                                                              AS last_note_at
      FROM credit_notes cn
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(cnl.unit_cost * cnl.quantity), 0) AS cost
        FROM credit_note_lines cnl
        WHERE cnl.credit_note_id = cn.id
          AND cnl.company_id = cn.company_id
      ) cn_cost ON true
      WHERE cn.is_deleted = false
      GROUP BY cn.company_id, cn.sale_invoice_id
    `);

    // ── 2. Venta consolidada (nivel factura) ─────────────────────────────────
    // La cifra que TODO informe de ventas debe usar. `sold_at` es la fecha en
    // que la venta se realizó: es la que usa el Resumen, y la que hace que un
    // pedido cobrado días después caiga en el mes correcto.
    await queryRunner.query(`
      CREATE OR REPLACE VIEW "v_sales_consolidated" AS
      SELECT
        si.id,
        si.company_id,
        si.customer_id,
        si.created_by_id,
        si.ticket_type,
        si.ticket_number,
        si.sale_number,
        si.is_deleted,
        si.created_at,
        COALESCE(si.sold_at, si.created_at)                       AS sold_at,
        si.total                                                  AS original_total,
        si.cost                                                   AS original_cost,
        COALESCE(adj.total_adjustment, 0)                         AS note_adjustment,
        COALESCE(adj.cost_adjustment, 0)                          AS note_cost_adjustment,
        si.total + COALESCE(adj.total_adjustment, 0)              AS total,
        si.cost  + COALESCE(adj.cost_adjustment, 0)               AS cost,
        (si.total + COALESCE(adj.total_adjustment, 0))
          - (si.cost + COALESCE(adj.cost_adjustment, 0))          AS profit,
        COALESCE(adj.notes_count, 0)                              AS notes_count,
        COALESCE(adj.credit_notes_count, 0)                       AS credit_notes_count,
        COALESCE(adj.debit_notes_count, 0)                        AS debit_notes_count,
        COALESCE(adj.has_full_void, false)                        AS has_full_void
      FROM sale_invoices si
      LEFT JOIN "v_sale_note_adjustments" adj
        ON adj.sale_invoice_id = si.id
       AND adj.company_id = si.company_id
    `);

    // ── 3. Línea consolidada (nivel producto) ────────────────────────────────
    // Para el Top de productos y el historial por producto, que agregan por
    // producto y no por factura. Las líneas de la nota entran con su signo, y
    // SIEMPRE se agrupan por `product_id`: agrupar por nombre hacía que un
    // producto renombrado apareciera dos veces y su nota se restara dos veces.
    await queryRunner.query(`
      CREATE OR REPLACE VIEW "v_sale_lines_consolidated" AS
      SELECT
        sil.company_id,
        sil.sale_invoice_id,
        sil.product_id,
        si.ticket_type,
        si.is_deleted,
        COALESCE(si.sold_at, si.created_at)  AS sold_at,
        sil.quantity                          AS quantity,
        sil.total                             AS total,
        sil.unit_cost * sil.quantity          AS cost,
        'SALE'::text                          AS source
      FROM sale_invoice_lines sil
      INNER JOIN sale_invoices si
        ON si.id = sil.sale_invoice_id
       AND si.company_id = sil.company_id

      UNION ALL

      SELECT
        cnl.company_id,
        cn.sale_invoice_id,
        cnl.product_id,
        si.ticket_type,
        si.is_deleted,
        COALESCE(si.sold_at, si.created_at)  AS sold_at,
        CASE WHEN cn.note_type = 'DEBIT' THEN cnl.quantity ELSE -cnl.quantity END,
        CASE WHEN cn.note_type = 'DEBIT' THEN cnl.total    ELSE -cnl.total    END,
        CASE WHEN cn.note_type = 'DEBIT'
             THEN  cnl.unit_cost * cnl.quantity
             ELSE -(cnl.unit_cost * cnl.quantity) END,
        'NOTE'::text                          AS source
      FROM credit_note_lines cnl
      INNER JOIN credit_notes cn
        ON cn.id = cnl.credit_note_id
       AND cn.company_id = cnl.company_id
       AND cn.is_deleted = false
      INNER JOIN sale_invoices si
        ON si.id = cn.sale_invoice_id
       AND si.company_id = cn.company_id
    `);

    // ── 4. Cobro por método (nivel factura) ──────────────────────────────────
    // Lo cobrado por cada medio, TOPADO contra el total de la factura una sola
    // vez. En efectivo `amount` es lo que entregó el cliente (vuelto incluido),
    // así que sin el tope una venta cobrada en dos pagos se contaba dos veces.
    await queryRunner.query(`
      CREATE OR REPLACE VIEW "v_sale_payments_consolidated" AS
      SELECT
        sp.company_id,
        sp.sale_invoice_id,
        sp.payment_method,
        LEAST(SUM(sp.amount), MAX(si.total))                        AS paid,
        SUM(sp.amount)                                              AS paid_raw,
        COUNT(*)                                                    AS payments_count,
        MAX(sp.bank_name)                                           AS bank_name
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON si.id = sp.sale_invoice_id
       AND si.company_id = sp.company_id
      WHERE sp.is_voided = false
      GROUP BY sp.company_id, sp.sale_invoice_id, sp.payment_method
    `);

    await queryRunner.query(`
      COMMENT ON VIEW "v_sales_consolidated" IS
      'Fuente unica de la verdad: venta con sus notas ya aplicadas (NC resta, ND suma). Usar SIEMPRE en informes en vez de sale_invoices.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW IF EXISTS "v_sale_payments_consolidated"`);
    await queryRunner.query(`DROP VIEW IF EXISTS "v_sale_lines_consolidated"`);
    await queryRunner.query(`DROP VIEW IF EXISTS "v_sales_consolidated"`);
    await queryRunner.query(`DROP VIEW IF EXISTS "v_sale_note_adjustments"`);
  }
}
