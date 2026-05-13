import Big from 'big.js';
import type { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';

/**
 * Agregaciones SQL compartidas entre los endpoints de `dashboard/*`. Espejo
 * fiel de PlacePos `dashboard.routes.ts` pero con el filtro multi-tenant
 * `company_id = $X` añadido a CADA query en CADA rama.
 *
 * Convención de parámetros:
 *   - `companyId` es SIEMPRE el primer placeholder ($1) para que las queries
 *     sean fácilmente auditables (un grep de `\$1` debe coincidir con el
 *     filtro de tenant).
 *
 * Todos los floats devueltos por Postgres son cast a `number` JS pero se
 * vuelven a `Big` en la capa de agregación antes de operar. Nunca operamos
 * con `number` directo en sumas monetarias (regla §2.5 y §8.1).
 */

export interface SalesByDayRow {
  date: string;
  sales: number;
  profit: number;
  cost: number;
}

export interface NotesByDayRow {
  date: string;
  note_type: 'CREDIT' | 'DEBIT';
  notes_total: number;
  notes_cost: number;
}

export interface ExpensesByDayRow {
  date: string;
  expenses: number;
}

export interface CreditPaymentBreakdownRow {
  date: string;
  sales_share: number;
  cost_share: number;
  profit_share: number;
}

export interface CreditsGeneratedRow {
  date: string;
  credits: number;
}

interface CreditPaymentRowRaw {
  date: string;
  amount_paid: number;
  consolidated_total: number;
  consolidated_cost: number;
}

interface AmountRow {
  amount: number;
}

interface NewCreditsRowRaw {
  count: string | number;
  amount: number;
}

export interface NewCreditsRow {
  count: number;
  amount: number;
}

/**
 * Ventas regulares (no crédito) agrupadas por día.
 * Filtro multi-tenant: `si.company_id = $1`.
 */
export async function fetchSalesByDay(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<SalesByDayRow[]> {
  return dataSource.query<SalesByDayRow[]>(
    `
    SELECT
      TO_CHAR(si.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
      COALESCE(SUM(si.total), 0)::float AS sales,
      COALESCE(SUM(si.profit), 0)::float AS profit,
      COALESCE(SUM(si.cost), 0)::float AS cost
    FROM sale_invoices si
    WHERE si.company_id = $1
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND si.created_at BETWEEN $2 AND $3
      AND NOT EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = si.id
          AND sc.company_id = $1
      )
    GROUP BY 1
    `,
    [String(companyId), dateStart, dateEnd],
  );
}

/**
 * Notas (CREDIT/DEBIT) aplicadas a ventas regulares, agrupadas por día y tipo.
 * Filtro multi-tenant: `cn.company_id = $1` Y `si.company_id = $1`.
 */
export async function fetchNotesByDay(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<NotesByDayRow[]> {
  return dataSource.query<NotesByDayRow[]>(
    `
    WITH note_costs AS (
      SELECT
        cn.id,
        cn.note_type,
        cn.sale_invoice_id,
        cn.total,
        COALESCE(SUM(cnl.unit_cost * cnl.quantity), 0) AS total_cost
      FROM credit_notes cn
      LEFT JOIN credit_note_lines cnl
        ON cnl.credit_note_id = cn.id
       AND cnl.company_id = $1
      WHERE cn.company_id = $1
        AND cn.is_deleted = false
      GROUP BY cn.id
    )
    SELECT
      TO_CHAR(si.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
      nc.note_type::text AS note_type,
      COALESCE(SUM(nc.total), 0)::float AS notes_total,
      COALESCE(SUM(nc.total_cost), 0)::float AS notes_cost
    FROM note_costs nc
    INNER JOIN sale_invoices si
      ON si.id = nc.sale_invoice_id
     AND si.company_id = $1
    WHERE si.is_deleted = false
      AND si.ticket_type = 'SALE'
      AND si.created_at BETWEEN $2 AND $3
      AND NOT EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = si.id
          AND sc.company_id = $1
      )
    GROUP BY 1, 2
    `,
    [String(companyId), dateStart, dateEnd],
  );
}

/**
 * Gastos por día (filtra archivados). Filtro multi-tenant: `e.company_id = $1`.
 */
export async function fetchExpensesByDay(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<ExpensesByDayRow[]> {
  return dataSource.query<ExpensesByDayRow[]>(
    `
    SELECT
      TO_CHAR(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
      COALESCE(SUM(e.amount), 0)::float AS expenses
    FROM expenses e
    WHERE e.company_id = $1
      AND e.is_archived = false
      AND e.created_at BETWEEN $2 AND $3
    GROUP BY 1
    `,
    [String(companyId), dateStart, dateEnd],
  );
}

/**
 * Descompone proporcionalmente cada abono recibido a una venta-credit en
 * (sales_share, cost_share, profit_share) para preservar la identidad
 * `recaudo = costo + ganancia` agregada por día.
 *
 * Filtro multi-tenant: presente en cada JOIN (sale_payments, sale_invoices,
 * sale_credits, credit_notes).
 */
export async function fetchCreditPaymentsBreakdownByDay(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<CreditPaymentBreakdownRow[]> {
  const rows = await dataSource.query<CreditPaymentRowRaw[]>(
    `
    WITH note_aggregates AS (
      SELECT
        cn.sale_invoice_id,
        COALESCE(SUM(CASE WHEN cn.note_type = 'DEBIT' THEN cn.total ELSE 0 END), 0) AS debit_total,
        COALESCE(SUM(CASE WHEN cn.note_type = 'CREDIT' THEN cn.total ELSE 0 END), 0) AS credit_total,
        COALESCE(SUM(CASE WHEN cn.note_type = 'DEBIT' THEN (
          SELECT COALESCE(SUM(cnl.unit_cost * cnl.quantity), 0)
          FROM credit_note_lines cnl
          WHERE cnl.credit_note_id = cn.id
            AND cnl.company_id = $1
        ) ELSE 0 END), 0) AS debit_cost,
        COALESCE(SUM(CASE WHEN cn.note_type = 'CREDIT' THEN (
          SELECT COALESCE(SUM(cnl.unit_cost * cnl.quantity), 0)
          FROM credit_note_lines cnl
          WHERE cnl.credit_note_id = cn.id
            AND cnl.company_id = $1
        ) ELSE 0 END), 0) AS credit_cost
      FROM credit_notes cn
      WHERE cn.company_id = $1
        AND cn.is_deleted = false
      GROUP BY cn.sale_invoice_id
    )
    SELECT
      TO_CHAR(sp.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
      sp.amount::float AS amount_paid,
      (si.total + COALESCE(na.debit_total, 0) - COALESCE(na.credit_total, 0))::float AS consolidated_total,
      (si.cost  + COALESCE(na.debit_cost, 0)  - COALESCE(na.credit_cost, 0))::float  AS consolidated_cost
    FROM sale_payments sp
    INNER JOIN sale_invoices si
      ON si.id = sp.sale_invoice_id
     AND si.company_id = $1
    INNER JOIN sale_credits sc
      ON sc.sale_invoice_id = si.id
     AND sc.company_id = $1
    LEFT JOIN note_aggregates na ON na.sale_invoice_id = si.id
    WHERE sp.company_id = $1
      AND sp.created_at BETWEEN $2 AND $3
      AND si.is_deleted = false
      AND si.ticket_type = 'SALE'
    `,
    [String(companyId), dateStart, dateEnd],
  );

  const byDate = new Map<string, { sales: Big; cost: Big; profit: Big }>();
  for (const row of rows) {
    const total = toBig(row.consolidated_total);
    if (total.lte(0)) {
      continue;
    }
    const cost = toBig(row.consolidated_cost);
    const profit = total.minus(cost);
    const amount = toBig(row.amount_paid);
    const effective = amount.lt(total) ? amount : total;
    const costShare = effective.times(cost).div(total);
    const profitShare = effective.times(profit).div(total);
    const acc = byDate.get(row.date) ?? { sales: new Big(0), cost: new Big(0), profit: new Big(0) };
    byDate.set(row.date, {
      sales: acc.sales.plus(effective),
      cost: acc.cost.plus(costShare),
      profit: acc.profit.plus(profitShare),
    });
  }

  return Array.from(byDate.entries()).map(([date, v]) => ({
    date,
    sales_share: v.sales.toNumber(),
    cost_share: v.cost.toNumber(),
    profit_share: v.profit.toNumber(),
  }));
}

/**
 * Créditos GENERADOS por día (sale_credits creados a partir de invoices del
 * rango). Filtro multi-tenant: `sc.company_id = $1` Y `si.company_id = $1`.
 */
export async function fetchCreditsGeneratedByDay(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<CreditsGeneratedRow[]> {
  return dataSource.query<CreditsGeneratedRow[]>(
    `
    SELECT
      TO_CHAR(si.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
      COALESCE(SUM(sc.total_amount), 0)::float AS credits
    FROM sale_credits sc
    INNER JOIN sale_invoices si
      ON si.id = sc.sale_invoice_id
     AND si.company_id = $1
    WHERE sc.company_id = $1
      AND si.created_at BETWEEN $2 AND $3
      AND si.is_deleted = false
      AND si.ticket_type = 'SALE'
    GROUP BY 1
    `,
    [String(companyId), dateStart, dateEnd],
  );
}

/**
 * Total monetario de pagos de venta por método. `onlyCredits`:
 *   - true  → solo abonos a invoices a crédito (Activos del día).
 *   - false → solo pagos a invoices no-crédito (recaudo directo).
 *
 * Filtro multi-tenant: `sp.company_id = $1` Y `si.company_id = $1`.
 */
export async function fetchPaymentsTotal(
  dataSource: DataSource,
  companyId: number,
  method: 'CASH' | 'TRANSFER',
  onlyCredits: boolean,
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const creditFilter = onlyCredits
    ? `AND EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = sp.sale_invoice_id
          AND sc.company_id = $1
      )`
    : `AND NOT EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = sp.sale_invoice_id
          AND sc.company_id = $1
      )`;
  const dateColumn = onlyCredits ? 'sp.created_at' : 'si.created_at';

  const rows = await dataSource.query<AmountRow[]>(
    `
    SELECT COALESCE(SUM(LEAST(sp.amount, si.total)), 0)::float AS amount
    FROM sale_payments sp
    INNER JOIN sale_invoices si
      ON sp.sale_invoice_id = si.id
     AND si.company_id = $1
    WHERE sp.company_id = $1
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND sp.payment_method = $2::payment_method
      AND ${dateColumn} BETWEEN $3 AND $4
      ${creditFilter}
    `,
    [String(companyId), method, dateStart, dateEnd],
  );
  return Number(rows[0]?.amount ?? 0);
}

/**
 * Ajuste por nota (CREDIT/DEBIT) aplicada a una venta regular pagada por el
 * método indicado. Espejo de la lógica per-method de PlacePos.
 */
export async function fetchSalesNotesAdjustment(
  dataSource: DataSource,
  companyId: number,
  method: 'CASH' | 'TRANSFER',
  noteType: 'CREDIT' | 'DEBIT',
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const rows = await dataSource.query<AmountRow[]>(
    `
    SELECT COALESCE(SUM(cn.total), 0)::float AS amount
    FROM credit_notes cn
    INNER JOIN sale_invoices si
      ON cn.sale_invoice_id = si.id
     AND si.company_id = $1
    INNER JOIN sale_payments sp
      ON sp.sale_invoice_id = si.id
     AND sp.company_id = $1
    WHERE cn.company_id = $1
      AND cn.is_deleted = false
      AND cn.note_type = $2::note_type
      AND sp.payment_method = $3::payment_method
      AND si.is_deleted = false
      AND si.ticket_type = 'SALE'
      AND si.created_at BETWEEN $4 AND $5
      AND NOT EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = si.id
          AND sc.company_id = $1
      )
    `,
    [String(companyId), noteType, method, dateStart, dateEnd],
  );
  return Number(rows[0]?.amount ?? 0);
}

/**
 * Ganancia total del rango: ventas regulares ajustadas por notas + share
 * proporcional de abonos a créditos. Espejo PlacePos `fetchProfitTotal`.
 */
export async function fetchProfitTotal(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  // 1. Profit de ventas regulares (excluye invoices a crédito).
  const salesRows = await dataSource.query<AmountRow[]>(
    `
    SELECT COALESCE(SUM(si.profit), 0)::float AS amount
    FROM sale_invoices si
    WHERE si.company_id = $1
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND si.created_at BETWEEN $2 AND $3
      AND NOT EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = si.id
          AND sc.company_id = $1
      )
    `,
    [String(companyId), dateStart, dateEnd],
  );
  const baseProfit = Number(salesRows[0]?.amount ?? 0);

  // 2. Ajuste por notas aplicadas a esas ventas.
  const notesRows = await fetchNotesByDay(dataSource, companyId, dateStart, dateEnd);
  let profit = toBig(baseProfit);
  for (const row of notesRows) {
    const noteProfit = toBig(row.notes_total).minus(toBig(row.notes_cost));
    profit = row.note_type === 'CREDIT' ? profit.minus(noteProfit) : profit.plus(noteProfit);
  }

  // 3. Profit proporcional de abonos a invoices a crédito.
  const creditBreakdown = await fetchCreditPaymentsBreakdownByDay(
    dataSource,
    companyId,
    dateStart,
    dateEnd,
  );
  for (const row of creditBreakdown) {
    profit = profit.plus(toBig(row.profit_share));
  }
  return profit.toNumber();
}

/**
 * Total de gastos no archivados en el rango. Filtro multi-tenant `e.company_id = $1`.
 */
export async function fetchExpensesTotal(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const rows = await dataSource.query<AmountRow[]>(
    `
    SELECT COALESCE(SUM(e.amount), 0)::float AS amount
    FROM expenses e
    WHERE e.company_id = $1
      AND e.is_archived = false
      AND e.created_at BETWEEN $2 AND $3
    `,
    [String(companyId), dateStart, dateEnd],
  );
  return Number(rows[0]?.amount ?? 0);
}

/**
 * Conteo + total de créditos generados (sale_credits cuya invoice se creó en
 * el rango). Filtro multi-tenant en ambas tablas.
 */
export async function fetchNewCredits(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<NewCreditsRow> {
  const rows = await dataSource.query<NewCreditsRowRaw[]>(
    `
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(sc.total_amount), 0)::float AS amount
    FROM sale_credits sc
    INNER JOIN sale_invoices si
      ON si.id = sc.sale_invoice_id
     AND si.company_id = $1
    WHERE sc.company_id = $1
      AND si.created_at BETWEEN $2 AND $3
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
    `,
    [String(companyId), dateStart, dateEnd],
  );
  return { count: Number(rows[0]?.count ?? 0), amount: Number(rows[0]?.amount ?? 0) };
}

/**
 * Redondea a 2 decimales monetarios. Atajo sobre `preciseNumber`.
 */
export function round2(value: unknown): number {
  return preciseNumber(value, 2);
}
