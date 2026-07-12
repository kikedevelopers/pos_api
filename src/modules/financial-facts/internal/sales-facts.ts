import type { DataSource } from 'typeorm';

import { computeRealizedProfit, type NoteTotals } from './profit-model';

/**
 * Facts de VENTAS (base devengada). Fuente única de la "Ganancia del día"
 * (headline) del contrato canónico (`../contracts/metrics-spec.md`).
 *
 * Multi-tenant: `company_id = $1` en cada tabla. Reconocimiento por
 * `COALESCE(si.sold_at, si.created_at)` (día de la venta).
 */

interface AmountRow {
  amount: number;
}

interface NoteRow {
  note_type: 'CREDIT' | 'DEBIT';
  total: number;
  cost: number;
}

/**
 * Utilidad DEVENGADA base del rango = `SUM(si.profit)` de TODAS las ventas
 * (SALE no borradas) realizadas en el rango. **Incluye ventas a crédito** (sin
 * filtro `NOT EXISTS sale_credits`): su utilidad se reconoce el día de la venta.
 */
export async function fetchRealizedProfitBase(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const rows = await dataSource.query<AmountRow[]>(
    `
    SELECT COALESCE(SUM(si.profit), 0)::float AS amount
    FROM sale_invoices si
    WHERE si.company_id = $1
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
    `,
    [String(companyId), dateStart, dateEnd],
  );
  return Number(rows[0]?.amount ?? 0);
}

/**
 * Totales de notas (CREDIT/DEBIT) aplicadas a ventas realizadas en el rango,
 * con su costo (`SUM(unit_cost*quantity)`). Sobre TODAS las ventas (incluye
 * crédito) para netear la utilidad devengada headline. El costo se agrega por
 * nota en un subquery para no duplicar `cn.total` por línea.
 */
export async function fetchNoteTotals(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<NoteTotals> {
  const rows = await dataSource.query<NoteRow[]>(
    `
    SELECT
      cn.note_type::text AS note_type,
      COALESCE(SUM(cn.total), 0)::float AS total,
      COALESCE(SUM(lc.cost), 0)::float AS cost
    FROM credit_notes cn
    INNER JOIN sale_invoices si
      ON si.id = cn.sale_invoice_id
     AND si.company_id = $1
    LEFT JOIN (
      SELECT cnl.credit_note_id, SUM(cnl.unit_cost * cnl.quantity) AS cost
      FROM credit_note_lines cnl
      WHERE cnl.company_id = $1
      GROUP BY cnl.credit_note_id
    ) lc ON lc.credit_note_id = cn.id
    WHERE cn.company_id = $1
      AND cn.is_deleted = false
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
    GROUP BY cn.note_type
    `,
    [String(companyId), dateStart, dateEnd],
  );

  const notes: NoteTotals = { creditTotal: 0, creditCost: 0, debitTotal: 0, debitCost: 0 };
  for (const row of rows) {
    if (row.note_type === 'CREDIT') {
      notes.creditTotal = Number(row.total);
      notes.creditCost = Number(row.cost);
    } else {
      notes.debitTotal = Number(row.total);
      notes.debitCost = Number(row.cost);
    }
  }
  return notes;
}

/**
 * "Ganancia del día" DEVENGADA del rango: base `SUM(si.profit)` de todas las
 * ventas + ajuste de notas. Es la métrica `realizedProfit` del contrato.
 */
export async function fetchRealizedProfit(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const [base, notes] = await Promise.all([
    fetchRealizedProfitBase(dataSource, companyId, dateStart, dateEnd),
    fetchNoteTotals(dataSource, companyId, dateStart, dateEnd),
  ]);
  return computeRealizedProfit(base, notes);
}
