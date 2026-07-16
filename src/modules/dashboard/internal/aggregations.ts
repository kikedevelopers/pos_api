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
  profit: number;
}

export interface NewCreditsRow {
  count: number;
  amount: number;
  // Ganancia DEVENGADA del crédito generado (proporcional a lo financiado).
  profit: number;
}

/**
 * Ventas agrupadas por día (devengado, por `COALESCE(sold_at, created_at)`).
 * Filtro multi-tenant: `si.company_id = $1`.
 *
 * `includeCredit`:
 *   - `false` (default, base CAJA): excluye las ventas a crédito — solo suman
 *     al recaudo cuando se cobran (abonos). Es lo que usa el dashboard
 *     (recaudo/impacto de gastos).
 *   - `true` (base DEVENGADO): incluye las ventas a crédito por su valor
 *     íntegro el día de la venta, como una venta más. Lo usa la Comparativa
 *     (una venta a crédito es una venta).
 */
export async function fetchSalesByDay(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
  includeCredit = false,
): Promise<SalesByDayRow[]> {
  const creditFilter = includeCredit
    ? ''
    : `AND NOT EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = si.id
          AND sc.company_id = $1
      )`;
  return dataSource.query<SalesByDayRow[]>(
    `
    SELECT
      TO_CHAR(COALESCE(si.sold_at, si.created_at) AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS date,
      COALESCE(SUM(si.total), 0)::float AS sales,
      COALESCE(SUM(si.profit), 0)::float AS profit,
      COALESCE(SUM(si.cost), 0)::float AS cost
    FROM sale_invoices si
    WHERE si.company_id = $1
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
      ${creditFilter}
    GROUP BY 1
    `,
    [String(companyId), dateStart, dateEnd],
  );
}

/**
 * Notas (CREDIT/DEBIT) aplicadas a ventas, agrupadas por día y tipo.
 * Filtro multi-tenant: `cn.company_id = $1` Y `si.company_id = $1`.
 *
 * `includeCredit` (idéntico a `fetchSalesByDay`): con `false` (default) solo
 * netea notas de ventas de contado; con `true` también las de ventas a crédito,
 * para que el neto devengado de la Comparativa sea coherente con sus ventas.
 */
export async function fetchNotesByDay(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
  includeCredit = false,
): Promise<NotesByDayRow[]> {
  const creditFilter = includeCredit
    ? ''
    : `AND NOT EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = si.id
          AND sc.company_id = $1
      )`;
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
      TO_CHAR(COALESCE(si.sold_at, si.created_at) AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS date,
      nc.note_type::text AS note_type,
      COALESCE(SUM(nc.total), 0)::float AS notes_total,
      COALESCE(SUM(nc.total_cost), 0)::float AS notes_cost
    FROM note_costs nc
    INNER JOIN sale_invoices si
      ON si.id = nc.sale_invoice_id
     AND si.company_id = $1
    WHERE si.is_deleted = false
      AND si.ticket_type = 'SALE'
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
      ${creditFilter}
    GROUP BY 1, 2
    `,
    [String(companyId), dateStart, dateEnd],
  );
}

/**
 * Gastos por día: SOLO `expenses` VARIABLES no archivados (`is_fixed = false`).
 * Filtro multi-tenant.
 *
 * Los gastos FIJOS (`is_fixed = true`, materializados al pagar un corte) NO se
 * cuentan: el débito a la fuente ya bajó el saldo; restarlos de la ganancia los
 * doble-contaría. Solo restan los gastos variables.
 *
 * Los abonos a transportistas (`carrier_payments`) NO se cuentan como gasto:
 * el flete ya está capitalizado en el costo del producto (impacta P&L vía COGS
 * al vender); sumar también el abono lo doble-contaría. El egreso de caja del
 * abono lo refleja el Saldo Líquido por su `financial_movement`.
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
      TO_CHAR(e.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS date,
      COALESCE(SUM(e.amount), 0)::float AS expenses
    FROM expenses e
    WHERE e.company_id = $1
      AND e.is_archived = false
      AND e.is_fixed = false
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
      TO_CHAR(sp.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS date,
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
      AND sp.is_voided = false
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
 * Créditos GENERADOS por día (sale_credits de invoices REALIZADAS en el rango).
 * Se agrupa/filtra por `COALESCE(si.sold_at, si.created_at)` — el día en que la
 * venta se realizó/cobró, no el de su creación (paridad con placepos y con el
 * resto de agregaciones de ventas del día).
 * Filtro multi-tenant: `sc.company_id = $1` Y `si.company_id = $1`.
 */
export async function fetchCreditsGeneratedByDay(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<CreditsGeneratedRow[]> {
  return dataSource.query<CreditsGeneratedRow[]>(
    `
    WITH note_agg AS (
      SELECT
        cn.sale_invoice_id,
        COALESCE(SUM(CASE WHEN cn.note_type = 'DEBIT' THEN cn.total ELSE -cn.total END), 0) AS total_adj
      FROM credit_notes cn
      WHERE cn.company_id = $1
        AND cn.is_deleted = false
      GROUP BY cn.sale_invoice_id
    )
    SELECT
      TO_CHAR(COALESCE(si.sold_at, si.created_at) AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS date,
      -- Valor CONSOLIDADO del crédito (neto de notas), coherente con el resto.
      COALESCE(SUM(si.total + COALESCE(na.total_adj, 0)), 0)::float AS credits
    FROM sale_credits sc
    INNER JOIN sale_invoices si
      ON si.id = sc.sale_invoice_id
     AND si.company_id = $1
    LEFT JOIN note_agg na ON na.sale_invoice_id = si.id
    WHERE sc.company_id = $1
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
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
 * SIEMPRE se filtra por `sp.created_at` (la fecha en que ENTRÓ el dinero), NO
 * por `si.created_at` (fecha de creación de la venta). Así el recaudo mide
 * "dinero recibido en el rango" en AMBAS ramas: un PEDIDO creado en un día
 * anterior y cobrado hoy suma en el recaudo de HOY. Para una venta de contado
 * normal (creada y pagada el mismo día) `sp.created_at ≈ si.created_at`, así que
 * el resultado NO cambia.
 *
 * Contabilidad de caja: la GANANCIA (`fetchProfitTotal`) y las VENTAS del día
 * (`fetchSalesByDay`, etc.) ahora se reconocen por `COALESCE(si.sold_at,
 * si.created_at)` — el día en que la venta se realizó/cobró. Así el recaudo
 * directo (por `sp.created_at`) y la ganancia/ventas del día CUADRAN para un
 * pedido creado en un día y cobrado en otro (ambos caen el día del cobro).
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
  // Recaudo = dinero recibido en el rango → SIEMPRE por la fecha del PAGO.
  const dateColumn = 'sp.created_at';

  const rows = await dataSource.query<AmountRow[]>(
    `
    SELECT COALESCE(SUM(LEAST(sp.amount, si.total)), 0)::float AS amount
    FROM sale_payments sp
    INNER JOIN sale_invoices si
      ON sp.sale_invoice_id = si.id
     AND si.company_id = $1
    WHERE sp.company_id = $1
      AND sp.is_voided = false
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
     AND sp.is_voided = false
    WHERE cn.company_id = $1
      AND cn.is_deleted = false
      AND cn.note_type = $2::note_type
      AND sp.payment_method = $3::payment_method
      AND si.is_deleted = false
      AND si.ticket_type = 'SALE'
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $4 AND $5
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

// NOTA: `fetchProfitTotal` (ganancia híbrida: contado por columna + share
// proporcional de abonos) fue REEMPLAZADO por la ganancia DEVENGADA canónica
// `fetchRealizedProfit` (financial-facts/internal/sales-facts.ts), que hoy usan
// `get-today` y `break-even`. Ver financial-facts/contracts/metrics-spec.md.

/**
 * Total de gastos del rango: SOLO `expenses` VARIABLES no archivados
 * (`is_fixed = false`). Filtro multi-tenant.
 *
 * Los gastos FIJOS (`is_fixed = true`) NO se cuentan: su débito a la fuente ya
 * bajó el saldo, así que restarlos de la ganancia los doble-contaría.
 *
 * Los abonos a transportistas (`carrier_payments`) NO son gasto del día: el
 * costo del transporte ya se capitaliza en el COSTO del producto (prorrata de
 * flete), por lo que impacta P&L vía COGS al vender. Contar también el abono
 * como gasto lo DOBLE-CONTARÍA. El abono solo mueve caja (su
 * `financial_movement`), que el Saldo Líquido refleja por separado.
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
      AND e.is_fixed = false
      AND e.created_at BETWEEN $2 AND $3
    `,
    [String(companyId), dateStart, dateEnd],
  );
  return Number(rows[0]?.amount ?? 0);
}

/**
 * Conteo + total de créditos generados (sale_credits cuya invoice se REALIZÓ
 * en el rango, por `COALESCE(si.sold_at, si.created_at)`). Filtro multi-tenant
 * en ambas tablas.
 */
export async function fetchNewCredits(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<NewCreditsRow> {
  const rows = await dataSource.query<NewCreditsRowRaw[]>(
    `
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
      COUNT(*) AS count,
      -- Valor y ganancia CONSOLIDADOS (neto de notas): un crédito anulado/editado
      -- vía notas refleja su valor neto, igual que el Reporte de Ventas.
      COALESCE(SUM(si.total + COALESCE(na.total_adj, 0)), 0)::float AS amount,
      COALESCE(SUM((si.total + COALESCE(na.total_adj, 0)) - (si.cost + COALESCE(na.cost_adj, 0))), 0)::float AS profit
    FROM sale_credits sc
    INNER JOIN sale_invoices si
      ON si.id = sc.sale_invoice_id
     AND si.company_id = $1
    LEFT JOIN note_agg na ON na.sale_invoice_id = si.id
    WHERE sc.company_id = $1
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
    `,
    [String(companyId), dateStart, dateEnd],
  );
  return {
    count: Number(rows[0]?.count ?? 0),
    amount: Number(rows[0]?.amount ?? 0),
    profit: Number(rows[0]?.profit ?? 0),
  };
}

/**
 * Conteo de tickets V (SALE) del rango. Espejo PlacePos `fetchSalesCount`
 * (`dashboard.routes.ts:569`). Solo se usa para mostrar "N° de ventas hoy"
 * en `/dashboard/today` — no incluye notas ni abonos.
 */
export async function fetchSalesCount(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const rows = await dataSource.query<{ count: string | number }[]>(
    `
    SELECT COUNT(*)::int AS count
    FROM sale_invoices si
    WHERE si.company_id = $1
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
    `,
    [String(companyId), dateStart, dateEnd],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Conteo + total de compras realizadas en el rango.
 * Espejo PlacePos `fetchPurchasesToday` (`dashboard.routes.ts:584`).
 * Multi-tenant: `purchases.company_id = $1`.
 */
export async function fetchPurchasesToday(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<{ count: number; amount: number }> {
  const rows = await dataSource.query<{ count: string | number; amount: number }[]>(
    `
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(total), 0)::float AS amount
    FROM purchases
    WHERE company_id = $1
      AND created_at BETWEEN $2 AND $3
    `,
    [String(companyId), dateStart, dateEnd],
  );
  return { count: Number(rows[0]?.count ?? 0), amount: Number(rows[0]?.amount ?? 0) };
}

/**
 * Pagos a compras del rango agrupados por método. Espejo PlacePos
 * `fetchPurchasePaymentsToday` (`dashboard.routes.ts:602`). Multi-tenant.
 */
export async function fetchPurchasePaymentsToday(
  dataSource: DataSource,
  companyId: number,
  method: 'CASH' | 'TRANSFER',
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const rows = await dataSource.query<AmountRow[]>(
    `
    SELECT COALESCE(SUM(amount), 0)::float AS amount
    FROM purchase_payments
    WHERE company_id = $1
      AND payment_method = $2::payment_method
      AND created_at BETWEEN $3 AND $4
    `,
    [String(companyId), method, dateStart, dateEnd],
  );
  return Number(rows[0]?.amount ?? 0);
}

/**
 * Deuda viva con proveedores: saldo pendiente de TODOS los créditos de
 * compra sin importar la fecha (cartera). Espejo PlacePos
 * `fetchSupplierDebt` (`dashboard.routes.ts:622`). Multi-tenant.
 */
export async function fetchSupplierDebt(
  dataSource: DataSource,
  companyId: number,
): Promise<number> {
  const rows = await dataSource.query<AmountRow[]>(
    `
    SELECT COALESCE(SUM(balance), 0)::float AS amount
    FROM purchase_credits
    WHERE company_id = $1
      AND status <> 'PAID'
    `,
    [String(companyId)],
  );
  return Number(rows[0]?.amount ?? 0);
}

/**
 * Saldo VIVO de las compras a crédito GENERADAS HOY (en el rango): `SUM(balance)`
 * de los `purchase_credits` no pagados creados dentro del día. Permite derivar
 * la deuda anterior: `deudaAnterior = supplierDebt - todayCreditsBalance`.
 * Espejo PlacePos `buildTodaySummary` (`dashboard.routes.ts`). Multi-tenant:
 * `purchase_credits.company_id = $1`.
 */
export async function fetchTodayCreditsBalance(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const rows = await dataSource.query<AmountRow[]>(
    `
    SELECT COALESCE(SUM(balance), 0)::float AS amount
    FROM purchase_credits
    WHERE company_id = $1
      AND status <> 'PAID'
      AND created_at BETWEEN $2 AND $3
    `,
    [String(companyId), dateStart, dateEnd],
  );
  return Number(rows[0]?.amount ?? 0);
}

/**
 * Redondea a 2 decimales monetarios. Atajo sobre `preciseNumber`.
 */
export function round2(value: unknown): number {
  return preciseNumber(value, 2);
}
