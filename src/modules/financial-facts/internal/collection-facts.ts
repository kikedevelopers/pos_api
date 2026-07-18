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

/** Filtro de pagos que son abonos a una venta A CRÉDITO. */
const ABONO_PAYMENT_FILTER = `AND EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = si.id
          AND sc.company_id = $1
      )`;

/**
 * Antigüedad del crédito al que se abona: TRUE si la venta a crédito nació HOY
 * (dentro del rango `$2..$3`), FALSE si es de días anteriores. El dinero del
 * abono siempre entró hoy (`sp.created_at`); esto discrimina POR EDAD DEL CRÉDITO.
 */
const CREDIT_IS_TODAY = `(COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3)`;

/**
 * SQL de utilidad cobrada proporcional. `paymentFilter` restringe el conjunto de
 * pagos (p.ej. solo abonos a crédito); vacío = todos (contado + abonos).
 * `groupByCreditAge` añade la columna `is_today` (edad del crédito) y agrupa por
 * ella: el `SUM` por-factura se PARTICIONA, así que la suma de los grupos es
 * EXACTAMENTE el total sin agrupar.
 */
function collectedProfitSql(paymentFilter: string, groupByCreditAge = false): string {
  const ageColumn = groupByCreditAge ? `${CREDIT_IS_TODAY} AS is_today,` : '';
  const ageGroupBy = groupByCreditAge ? 'GROUP BY is_today' : '';
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
    SELECT
      ${ageColumn}
      COALESCE(SUM(
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
    ${ageGroupBy}
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
  const rows = await dataSource.query<AmountRow[]>(collectedProfitSql(ABONO_PAYMENT_FILTER), [
    String(companyId),
    dateStart,
    dateEnd,
  ]);
  return Number(rows[0]?.amount ?? 0);
}

/** Utilidad cobrada de abonos discriminada por edad del crédito. */
export interface AbonoCollectedProfitByAge {
  /** Abonos a créditos de DÍAS ANTERIORES (nacidos antes de hoy). */
  previous: number;
  /** Abonos a créditos DEL DÍA (nacidos hoy). */
  today: number;
}

/**
 * Utilidad COBRADA de abonos a crédito (proporcional) DISCRIMINADA por edad del
 * crédito: días anteriores vs del día. `previous + today` ≡ `fetchAbonoCollectedProfit`
 * (misma SQL, solo particionada por `is_today`).
 */
export async function fetchAbonoCollectedProfitByCreditAge(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<AbonoCollectedProfitByAge> {
  const rows = await dataSource.query<{ is_today: boolean; amount: number }[]>(
    collectedProfitSql(ABONO_PAYMENT_FILTER, true),
    [String(companyId), dateStart, dateEnd],
  );
  const result: AbonoCollectedProfitByAge = { previous: 0, today: 0 };
  for (const row of rows) {
    if (row.is_today) {
      result.today = Number(row.amount ?? 0);
    } else {
      result.previous = Number(row.amount ?? 0);
    }
  }
  return result;
}
