import type { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

/**
 * Agregaciones de VENTAS compartidas entre `get-daily-closure.action.ts` y
 * `get-extended-summary.action.ts`.
 *
 * Toda la lógica opera sobre un rango `[dateStart, dateEnd]` (instantes UTC ya
 * resueltos por quien llame — el cierre usa `parseUtcRange`, el resumen
 * extendido usa `parseDateRange`/Colombia). El helper es NEUTRO a la zona: solo
 * recibe los `Date` límite. Así ambas acciones reutilizan EXACTAMENTE las
 * mismas queries y el mismo cálculo de netos/utilidad sin divergir.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * TODAS las queries filtran por `company_id = $1` en cada tabla del JOIN. Si
 * una rama lo omitiera, una company vería datos de otra — bug CRÍTICO.
 *
 * --------------------------------------------------------------------------
 * Reglas financieras (espejo PlacePos byte-por-byte)
 * --------------------------------------------------------------------------
 *
 *   - Ventas en efectivo NETAS = gross - NC(CREDIT) + ND(DEBIT) sobre el rango.
 *   - Consignaciones (TRANSFER) brutas + costo para utilidad.
 *   - Créditos nuevos = ventas a crédito generadas en el rango.
 *   - Big.js para todo cálculo/redondeo monetario.
 */

export interface SalesRow {
  gross_sales: number;
  gross_cost: number;
}

export interface NotesRow {
  notes_total: number;
  notes_cost: number;
}

export interface ConsigRow {
  consig_total: number;
  consig_cost: number;
}

export interface ConsigDetalleRow {
  bank_name: string;
  amount: number;
}

export interface NewCreditsRow {
  new_credits_count: string | number;
  new_credits_total: number;
  pending_balance: number;
}

export interface OrdersBillingRow {
  orders_total: number;
  orders_cost: number;
}

/** Fila neutra de pedidos: lo que se usa cuando el flag está OFF (sin query). */
export const EMPTY_ORDERS_BILLING: OrdersBillingRow = { orders_total: 0, orders_cost: 0 };

export interface PendingCreditsRow {
  pending_count: string | number;
  total_amount: number;
  paid_amount: number;
  balance: number;
}

const round2 = (n: unknown): number => Number(toBig(n).round(2).toString());

/**
 * Ventas en efectivo BRUTAS del rango (gross_sales + gross_cost). Excluye
 * facturas que generaron crédito (`sale_credits`) — esas se cuentan como
 * créditos nuevos, no como venta de contado.
 *
 * Costo PRORRATEADO por el monto pagado: `si.cost * LEAST(sp.amount, si.total)
 * / si.total`. El JOIN produce UNA fila por pago, así que una factura con
 * varios pagos (o método mixto CASH+TRANSFER) aparece varias veces; un
 * `SUM(si.cost)` plano contaría su costo COMPLETO por cada pago, duplicándolo y
 * SUBESTIMANDO la utilidad. Prorratear reparte el costo en proporción a lo
 * cobrado por este método, de modo que la suma del costo entre todas las ramas
 * de la factura da su costo UNA sola vez (mismo criterio que el prorrateo de
 * abonos a crédito). Para una venta de contado pagada al 100% con un solo pago
 * el resultado es idéntico al costo completo. `NULLIF(si.total,0)` evita dividir
 * por cero en ventas de total 0.
 */
export async function fetchCashSales(
  dataSource: DataSource,
  cid: string,
  dateStart: Date,
  dateEnd: Date,
): Promise<SalesRow> {
  const rows = await dataSource.query<SalesRow[]>(
    `
      SELECT
        COALESCE(SUM(LEAST(sp.amount, si.total)), 0)::float AS gross_sales,
        COALESCE(SUM(si.cost * LEAST(sp.amount, si.total) / NULLIF(si.total, 0)), 0)::float AS gross_cost
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON sp.sale_invoice_id = si.id
       AND si.company_id = $1
      WHERE sp.company_id = $1
        AND sp.is_voided = false
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
        AND sp.payment_method = 'CASH'
        AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
        AND NOT EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = si.id
            AND sc.company_id = $1
        )
      `,
    [cid, dateStart, dateEnd],
  );
  return rows[0] ?? { gross_sales: 0, gross_cost: 0 };
}

/**
 * Notas de ajuste (CREDIT/DEBIT) aplicadas a facturas de contado del rango.
 * Devuelve total y costo para netear ventas y utilidad.
 */
export async function fetchCashNotes(
  dataSource: DataSource,
  cid: string,
  noteType: 'CREDIT' | 'DEBIT',
  dateStart: Date,
  dateEnd: Date,
): Promise<NotesRow> {
  const rows = await dataSource.query<NotesRow[]>(
    `
      SELECT
        COALESCE(SUM(cn.total), 0)::float AS notes_total,
        COALESCE(SUM(cnl.unit_cost * cnl.quantity), 0)::float AS notes_cost
      FROM credit_notes cn
      INNER JOIN sale_invoices si
        ON cn.sale_invoice_id = si.id
       AND si.company_id = $1
      INNER JOIN sale_payments sp
        ON sp.sale_invoice_id = si.id
       AND sp.company_id = $1
      LEFT JOIN credit_note_lines cnl
        ON cnl.credit_note_id = cn.id
       AND cnl.company_id = $1
      WHERE cn.company_id = $1
        AND cn.is_deleted = false
        AND cn.note_type = $2::note_type
        AND sp.is_voided = false
        AND sp.payment_method = 'CASH'
        AND si.is_deleted = false
        AND COALESCE(si.sold_at, si.created_at) BETWEEN $3 AND $4
        AND NOT EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = si.id
            AND sc.company_id = $1
        )
      `,
    [cid, noteType, dateStart, dateEnd],
  );
  return rows[0] ?? { notes_total: 0, notes_cost: 0 };
}

/**
 * Consignaciones (ventas TRANSFER) del rango: totales (con costo) + detalle
 * por banco.
 *
 * Costo PRORRATEADO por el monto pagado, igual que `fetchCashSales`: evita que
 * una factura con varios pagos o método mixto duplique su `si.cost` (una vez
 * por rama de pago). Ver la nota extensa en `fetchCashSales`.
 */
export async function fetchTransferSales(
  dataSource: DataSource,
  cid: string,
  dateStart: Date,
  dateEnd: Date,
): Promise<{ totals: ConsigRow; detalle: ConsigDetalleRow[] }> {
  const totals = await dataSource.query<ConsigRow[]>(
    `
      SELECT
        COALESCE(SUM(LEAST(sp.amount, si.total)), 0)::float AS consig_total,
        COALESCE(SUM(si.cost * LEAST(sp.amount, si.total) / NULLIF(si.total, 0)), 0)::float AS consig_cost
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON sp.sale_invoice_id = si.id
       AND si.company_id = $1
      WHERE sp.company_id = $1
        AND sp.is_voided = false
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
        AND sp.payment_method = 'TRANSFER'
        AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
        AND NOT EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = si.id
            AND sc.company_id = $1
        )
      `,
    [cid, dateStart, dateEnd],
  );

  const detalle = await dataSource.query<ConsigDetalleRow[]>(
    `
      SELECT
        COALESCE(sp.bank_name, 'Sin especificar') AS bank_name,
        COALESCE(SUM(LEAST(sp.amount, si.total)), 0)::float AS amount
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON sp.sale_invoice_id = si.id
       AND si.company_id = $1
      WHERE sp.company_id = $1
        AND sp.is_voided = false
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
        AND sp.payment_method = 'TRANSFER'
        AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
        AND NOT EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = si.id
            AND sc.company_id = $1
        )
      GROUP BY sp.bank_name
      ORDER BY amount DESC
      `,
    [cid, dateStart, dateEnd],
  );

  return { totals: totals[0] ?? { consig_total: 0, consig_cost: 0 }, detalle };
}

/**
 * Créditos nuevos del rango = ventas a crédito (ticket SALE con `sale_credits`)
 * generadas en `[dateStart, dateEnd]`. Devuelve conteo, total y saldo pendiente.
 */
export async function fetchNewCredits(
  dataSource: DataSource,
  cid: string,
  dateStart: Date,
  dateEnd: Date,
): Promise<NewCreditsRow> {
  const rows = await dataSource.query<NewCreditsRow[]>(
    `
      SELECT
        COUNT(*) AS new_credits_count,
        COALESCE(SUM(sc.total_amount), 0)::float AS new_credits_total,
        COALESCE(SUM(sc.balance), 0)::float AS pending_balance
      FROM sale_credits sc
      INNER JOIN sale_invoices si
        ON si.id = sc.sale_invoice_id
       AND si.company_id = $1
      WHERE sc.company_id = $1
        AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
      `,
    [cid, dateStart, dateEnd],
  );
  return (
    rows[0] ?? {
      new_credits_count: 0,
      new_credits_total: 0,
      pending_balance: 0,
    }
  );
}

/**
 * Facturación de PEDIDOS (`ticket_type = 'ORDER'`, no borrados) cuyo
 * `COALESCE(sold_at, created_at)` cae en el rango: total Y costo.
 *
 * Solo se invoca cuando el flag `include_orders_in_reports` de la company está
 * ON (con OFF ni siquiera se emite la query; ver `EMPTY_ORDERS_BILLING`).
 * Compartida por el cierre diario y el resumen extendido para que ambos midan
 * EXACTAMENTE lo mismo (la ventana temporal la fija quien llama).
 *
 * A diferencia de `fetchCashSales`/`fetchTransferSales`, NO hay JOIN a
 * `sale_payments`: un pedido se asume COMPLETO (no depende de lo cobrado), así
 * que no hay filas duplicadas por pago y `SUM(si.cost)` es directo, sin
 * prorrateo. Multi-tenant: `si.company_id = $1`.
 */
export async function fetchOrdersBilling(
  dataSource: DataSource,
  cid: string,
  dateStart: Date,
  dateEnd: Date,
): Promise<OrdersBillingRow> {
  const rows = await dataSource.query<OrdersBillingRow[]>(
    `
      SELECT
        COALESCE(SUM(si.total), 0)::float AS orders_total,
        COALESCE(SUM(si.cost), 0)::float AS orders_cost
      FROM sale_invoices si
      WHERE si.company_id = $1
        AND si.ticket_type = 'ORDER'
        AND si.is_deleted = false
        AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
      `,
    [cid, dateStart, dateEnd],
  );
  return rows[0] ?? EMPTY_ORDERS_BILLING;
}

/**
 * Utilidad de los pedidos = total - costo (Big.js). Es la ganancia REAL del
 * pedido: con el flag ON se asume el pedido COMPLETO, como si fuera una venta
 * normal (decisión de producto, spec Fase 2 §0).
 */
export function computeOrdersProfit(orders: OrdersBillingRow): number {
  return round2(toBig(orders.orders_total).minus(toBig(orders.orders_cost)).toNumber());
}

/** Misma facturación de pedidos, agrupada por día (gráfico Rendimiento). */
export interface OrdersByDayRow {
  date: string;
  orders_total: number;
  orders_cost: number;
}

/**
 * Agrupa en hora COLOMBIA (`AT TIME ZONE 'America/Bogota'`), igual que
 * `fetchSalesByDay`: agrupar en UTC metería las ventas de la noche en el día
 * siguiente y los buckets no cuadrarían entre series.
 */
export async function fetchOrdersByDay(
  dataSource: DataSource,
  cid: string,
  dateStart: Date,
  dateEnd: Date,
): Promise<OrdersByDayRow[]> {
  return dataSource.query<OrdersByDayRow[]>(
    `
      SELECT
        TO_CHAR(COALESCE(si.sold_at, si.created_at) AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS date,
        COALESCE(SUM(si.total), 0)::float AS orders_total,
        COALESCE(SUM(si.cost), 0)::float AS orders_cost
      FROM sale_invoices si
      WHERE si.company_id = $1
        AND si.ticket_type = 'ORDER'
        AND si.is_deleted = false
        AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
      GROUP BY 1
      `,
    [cid, dateStart, dateEnd],
  );
}

/**
 * Total de "Gastos" del periodo: SOLO `expenses` VARIABLES no archivados
 * (`is_fixed = false`).
 *
 * Los gastos FIJOS (`is_fixed = true`) NO se cuentan: su débito a la fuente ya
 * bajó el saldo; restarlos de la ganancia los doble-contaría. Solo restan los
 * gastos variables.
 *
 * Los abonos a transportistas (`carrier_payments`) NO son gasto: el flete ya
 * está capitalizado en el COSTO del producto (prorrata) e impacta P&L vía COGS
 * al vender; contarlo además como gasto lo doble-contaría. Espejo de la misma
 * exclusión en el dashboard (`aggregations.ts`).
 */
export async function fetchExpensesTotal(
  dataSource: DataSource,
  cid: string,
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const rows = await dataSource.query<{ expenses_total: number }[]>(
    `
      SELECT COALESCE(SUM(e.amount), 0)::float AS expenses_total
      FROM expenses e
      WHERE e.company_id = $1
        AND e.created_at BETWEEN $2 AND $3
        AND e.is_archived = false
        AND e.is_fixed = false
      `,
    [cid, dateStart, dateEnd],
  );
  return Number(rows[0]?.expenses_total ?? 0);
}

/** Fila cruda del detalle discriminado de gastos del día. */
export interface ExpenseDetailRow {
  concept: string;
  source: string | null;
  amount: number;
}

/**
 * Detalle discriminado de los gastos del día: concepto (`description`), fuente
 * (`source_name`) y monto, SOLO `expenses` VARIABLES no archivados. Misma
 * exclusión de archivados y de fijos (`is_fixed = false`) que
 * `fetchExpensesTotal`, para que el detalle cuadre con el total. Espejo PlacePos
 * `buildDailyClosureResult` (`ReportController.ts`). Multi-tenant:
 * `expenses.company_id = $1`.
 */
export async function fetchExpensesDetail(
  dataSource: DataSource,
  cid: string,
  dateStart: Date,
  dateEnd: Date,
): Promise<ExpenseDetailRow[]> {
  return dataSource.query<ExpenseDetailRow[]>(
    `
      SELECT
        e.description AS concept,
        e.source_name AS source,
        e.amount::float AS amount
      FROM expenses e
      WHERE e.company_id = $1
        AND e.created_at BETWEEN $2 AND $3
        AND e.is_archived = false
        AND e.is_fixed = false
      ORDER BY e.created_at ASC
      `,
    [cid, dateStart, dateEnd],
  );
}

/** Fila cruda de un abono/pago a un gasto FIJO del día (enlazado a su corte). */
export interface FixedExpensePaymentRow {
  concept: string;
  source: string | null;
  paid_amount: number;
  total_amount: number;
  balance: number;
  due_date: Date | string | null;
  paid_at: Date | string;
}

/**
 * Abonos/pagos a gastos FIJOS del rango: cada `Expense` con `is_fixed = true`
 * enlazado a su corte (`fixed_expense_periods` vía `fixed_expense_period_id`)
 * para exponer el monto total del corte, su saldo actual y su vencimiento, más
 * la fuente, lo abonado y cuándo se pagó. Alimenta el bloque "ABONOS A GASTOS
 * FIJOS" del cierre. INNER JOIN: excluye abonos sin enlace (gastos variables o
 * abonos previos a la columna); de aquí en adelante todos quedan enlazados.
 * Multi-tenant: `e.company_id = $1` (y el corte pertenece a la misma company).
 */
export async function fetchFixedExpensePaymentsDetail(
  dataSource: DataSource,
  cid: string,
  dateStart: Date,
  dateEnd: Date,
): Promise<FixedExpensePaymentRow[]> {
  return dataSource.query<FixedExpensePaymentRow[]>(
    `
      SELECT
        e.description AS concept,
        e.source_name AS source,
        e.amount::float AS paid_amount,
        p.amount::float AS total_amount,
        p.balance::float AS balance,
        p.due_at AS due_date,
        e.created_at AS paid_at
      FROM expenses e
      INNER JOIN fixed_expense_periods p
        ON p.id = e.fixed_expense_period_id
       AND p.company_id = $1
      WHERE e.company_id = $1
        AND e.created_at BETWEEN $2 AND $3
        AND e.is_archived = false
        AND e.is_fixed = true
      ORDER BY e.created_at ASC
      `,
    [cid, dateStart, dateEnd],
  );
}

/**
 * Saldo total pendiente (POINT-IN-TIME) de los créditos que REALMENTE se deben:
 * `SUM(balance)` de `sale_credits` con saldo > 0 cuya factura sea una VENTA NO
 * anulada. El INNER JOIN a `sale_invoices` (ticket_type='SALE', is_deleted=false)
 * es CLAVE: sin él se contarían créditos de ventas anuladas, inflando la cartera.
 * Coincide con el Reporte de Créditos (filtro "Pendientes").
 */
export async function fetchTotalPendingCredits(
  dataSource: DataSource,
  cid: string,
): Promise<PendingCreditsRow> {
  const rows = await dataSource.query<PendingCreditsRow[]>(
    `
      SELECT
        COUNT(*) AS pending_count,
        COALESCE(SUM(sc.total_amount), 0)::float AS total_amount,
        COALESCE(SUM(sc.paid_amount), 0)::float AS paid_amount,
        COALESCE(SUM(sc.balance), 0)::float AS balance
      FROM sale_credits sc
      INNER JOIN sale_invoices si
        ON si.id = sc.sale_invoice_id
       AND si.company_id = $1
      WHERE sc.company_id = $1
        AND sc.balance > 0
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
      `,
    [cid],
  );
  return (
    rows[0] ?? {
      pending_count: 0,
      total_amount: 0,
      paid_amount: 0,
      balance: 0,
    }
  );
}

export interface NetSalesResult {
  netSales: number;
  netCost: number;
  netProfit: number;
}

/**
 * Ventas en efectivo NETAS de NC/ND y su utilidad. Espejo PlacePos:
 *   netSales = gross - NC + ND ; netCost = grossCost - ncCost + ndCost.
 */
export function computeNetCashSales(
  sales: SalesRow,
  creditNotes: NotesRow,
  debitNotes: NotesRow,
): NetSalesResult {
  const netSales = round2(
    toBig(sales.gross_sales)
      .minus(toBig(creditNotes.notes_total))
      .plus(toBig(debitNotes.notes_total))
      .toNumber(),
  );
  const netCost = round2(
    toBig(sales.gross_cost)
      .minus(toBig(creditNotes.notes_cost))
      .plus(toBig(debitNotes.notes_cost))
      .toNumber(),
  );
  const netProfit = round2(toBig(netSales).minus(toBig(netCost)).toNumber());
  return { netSales, netCost, netProfit };
}

/**
 * Utilidad de consignaciones (TRANSFER) = total - costo.
 */
export function computeConsignacionesProfit(consig: ConsigRow): number {
  return round2(toBig(consig.consig_total).minus(toBig(consig.consig_cost)).toNumber());
}
