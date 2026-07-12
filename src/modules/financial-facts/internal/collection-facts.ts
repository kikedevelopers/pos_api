import type { DataSource } from 'typeorm';

/**
 * Facts de RECAUDO / utilidad COBRADA (base caja `sp.created_at`). Ver el
 * contrato canónico (`../contracts/metrics-spec.md`).
 *
 * Utilidad COBRADA por modelo PROPORCIONAL: CADA pago no anulado cobra una
 * porción proporcional de la utilidad consolidada (neta de notas) de su factura
 * — `LEAST(pago, total) · (total − cost) / total`. Para una venta de contado
 * pagada al 100% cobra la utilidad completa; para un abono, la parte
 * proporcional. Preserva `recaudo = costo + ganancia`. Sustituye al modelo
 * "cascada cost-first" del cierre viejo. Se usa para el excedente/reinversión
 * (`surplus = recaudo − collectedProfit`, = COGS cobrado) y para la
 * "Rentabilidad" del bloque de cartera.
 *
 * Multi-tenant: `company_id = $1` en cada tabla.
 */

interface AmountRow {
  amount: number;
}

/**
 * SQL de utilidad cobrada proporcional. `paymentFilter` restringe el conjunto de
 * pagos (p.ej. solo abonos a crédito); vacío = todos (contado + abonos).
 */
function collectedProfitSql(paymentFilter: string): string {
  return `
    WITH note_agg AS (
      SELECT
        cn.sale_invoice_id,
        COALESCE(SUM(CASE WHEN cn.note_type = 'DEBIT' THEN cn.total ELSE -cn.total END), 0) AS total_adj,
        COALESCE(SUM(CASE WHEN cn.note_type = 'DEBIT' THEN lc.cost ELSE -lc.cost END), 0) AS cost_adj
      FROM credit_notes cn
      LEFT JOIN (
        SELECT cnl.credit_note_id, SUM(cnl.unit_cost * cnl.quantity) AS cost
        FROM credit_note_lines cnl
        WHERE cnl.company_id = $1
        GROUP BY cnl.credit_note_id
      ) lc ON lc.credit_note_id = cn.id
      WHERE cn.company_id = $1
        AND cn.is_deleted = false
      GROUP BY cn.sale_invoice_id
    )
    SELECT COALESCE(SUM(
      LEAST(sp.amount, cons.total) * (cons.total - cons.cost) / NULLIF(cons.total, 0)
    ), 0)::float AS amount
    FROM sale_payments sp
    INNER JOIN sale_invoices si
      ON sp.sale_invoice_id = si.id
     AND si.company_id = $1
    LEFT JOIN note_agg na ON na.sale_invoice_id = si.id
    CROSS JOIN LATERAL (
      SELECT
        (si.total + COALESCE(na.total_adj, 0)) AS total,
        (si.cost  + COALESCE(na.cost_adj, 0)) AS cost
    ) cons
    WHERE sp.company_id = $1
      AND sp.is_voided = false
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND sp.created_at BETWEEN $2 AND $3
      ${paymentFilter}
  `;
}

/**
 * Utilidad COBRADA del rango (contado + abonos, proporcional, neta de notas).
 * Base caja: pagos por `sp.created_at`. Alimenta el excedente/reinversión.
 */
export async function fetchCollectedProfit(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const rows = await dataSource.query<AmountRow[]>(collectedProfitSql(''), [
    String(companyId),
    dateStart,
    dateEnd,
  ]);
  return Number(rows[0]?.amount ?? 0);
}

/**
 * Utilidad COBRADA SOLO de abonos a crédito (proporcional). Es la "Rentabilidad"
 * del bloque de recaudo de cartera. Sustituye al modelo cascada del cierre viejo.
 */
export async function fetchAbonoCollectedProfit(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const rows = await dataSource.query<AmountRow[]>(
    collectedProfitSql(
      `AND EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = si.id
          AND sc.company_id = $1
      )`,
    ),
    [String(companyId), dateStart, dateEnd],
  );
  return Number(rows[0]?.amount ?? 0);
}
