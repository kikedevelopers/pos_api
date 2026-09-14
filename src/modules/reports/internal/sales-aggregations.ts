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

/**
 * Ajuste por notas (NC/ND) de consignaciones, prorrateado por banco. `adj` ya
 * viene con signo (NC resta, ND suma) sobre la venta; `cost_adj` sobre el costo.
 */
export interface TransferNoteRow {
  bank_name: string;
  adj: number;
  cost_adj: number;
}

export interface NewCreditsRow {
  new_credits_count: string | number;
  new_credits_total: number;
  pending_balance: number;
  // Ganancia/costo DEVENGADOS del crédito generado (proporcional a lo financiado).
  new_credits_profit: number;
  new_credits_cost: number;
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
      -- El tope contra el total de la factura se aplica UNA vez, sobre la suma
      -- de sus pagos en efectivo. Antes se aplicaba a cada pago por separado
      -- (SUM(LEAST(sp.amount, si.total))), así que una venta cobrada en dos
      -- pagos con vuelto se contaba dos veces entera: medido en producción,
      -- PED-3071 (11.000) aportaba 22.000 y PED-3124 (18.600,24) aportaba
      -- 37.200,48. El tope existe porque en efectivo amount es lo que
      -- entregó el cliente, vuelto incluido.
      SELECT
        COALESCE(SUM(LEAST(pagos.pagado, si.total)), 0)::float AS gross_sales,
        COALESCE(SUM(si.cost * LEAST(pagos.pagado, si.total) / NULLIF(si.total, 0)), 0)::float AS gross_cost
      FROM sale_invoices si
      INNER JOIN LATERAL (
        SELECT SUM(sp.amount) AS pagado
        FROM sale_payments sp
        WHERE sp.sale_invoice_id = si.id
          AND sp.company_id = $1
          AND sp.is_voided = false
          AND sp.payment_method = 'CASH'
      ) pagos ON pagos.pagado IS NOT NULL
      WHERE si.company_id = $1
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
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
  // El costo de la nota se agrega en una SUBQUERY y la existencia de pago
  // CASH se comprueba con EXISTS. Antes esto eran dos JOIN (a
  // `credit_note_lines` y a `sale_payments`) y `SUM(cn.total)` se calculaba
  // sobre el producto cartesiano: una nota de 3 líneas se restaba 3 veces, y
  // otra vez por cada pago en efectivo de la factura. Medido en producción, el
  // cierre del 08-may restaba 32.000 por una NC de 16.000 y sumaba 38.100 por
  // una ND de 12.700.
  const rows = await dataSource.query<NotesRow[]>(
    `
      SELECT
        COALESCE(SUM(cn.total), 0)::float AS notes_total,
        COALESCE(SUM(cn_cost.note_cost), 0)::float AS notes_cost
      FROM credit_notes cn
      INNER JOIN sale_invoices si
        ON cn.sale_invoice_id = si.id
       AND si.company_id = $1
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(cnl.unit_cost * cnl.quantity), 0) AS note_cost
        FROM credit_note_lines cnl
        WHERE cnl.credit_note_id = cn.id
          AND cnl.company_id = $1
      ) cn_cost ON true
      WHERE cn.company_id = $1
        AND cn.is_deleted = false
        AND cn.note_type = $2::note_type
        AND si.is_deleted = false
        AND COALESCE(si.sold_at, si.created_at) BETWEEN $3 AND $4
        AND EXISTS (
          SELECT 1 FROM sale_payments sp
          WHERE sp.sale_invoice_id = si.id
            AND sp.company_id = $1
            AND sp.is_voided = false
            AND sp.payment_method = 'CASH'
        )
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
/**
 * Combina consignaciones BRUTAS con el ajuste por notas (NC/ND) → NETO: total,
 * costo y detalle por banco. Función PURA (testeable sin DB). El ajuste ya viene
 * con signo y prorrateado por banco desde la query. Los bancos que quedan en ~0
 * (venta totalmente anulada por NC) se omiten del detalle.
 */
export function computeNetConsignaciones(
  grossTotals: ConsigRow,
  grossDetalle: ConsigDetalleRow[],
  noteRows: TransferNoteRow[],
): { totals: ConsigRow; detalle: ConsigDetalleRow[] } {
  const totalAdj = noteRows.reduce((acc, r) => acc.plus(toBig(r.adj)), toBig(0));
  const costAdj = noteRows.reduce((acc, r) => acc.plus(toBig(r.cost_adj)), toBig(0));

  const consig_total = round2(toBig(grossTotals.consig_total).plus(totalAdj).toNumber());
  const consig_cost = round2(toBig(grossTotals.consig_cost).plus(costAdj).toNumber());

  const byBank = new Map<string, ReturnType<typeof toBig>>();
  for (const d of grossDetalle) byBank.set(d.bank_name, toBig(d.amount));
  for (const r of noteRows) {
    byBank.set(r.bank_name, (byBank.get(r.bank_name) ?? toBig(0)).plus(toBig(r.adj)));
  }

  const detalle: ConsigDetalleRow[] = [...byBank.entries()]
    .map(([bank_name, amt]) => ({ bank_name, amount: round2(amt.toNumber()) }))
    .filter((d) => Math.abs(d.amount) >= 0.005)
    .sort((a, b) => b.amount - a.amount);

  return { totals: { consig_total, consig_cost }, detalle };
}

/**
 * Consignaciones (ventas TRANSFER) del rango, NETAS de notas de ajuste (NC/ND).
 *
 * Bruto (`consig_total`/`consig_cost`/detalle por banco) igual que antes. Las
 * notas se netean SOLO para facturas SIN pago en efectivo (las que tienen algún
 * pago CASH las netea `fetchCashNotes` → evita doble conteo entre métodos; una
 * factura mixta cuenta su nota en efectivo, y el total contado queda correcto).
 * El ajuste se prorratea por banco según lo pagado a cada uno. NC resta, ND suma
 * — mismo criterio que el path de efectivo.
 */
export async function fetchTransferSales(
  dataSource: DataSource,
  cid: string,
  dateStart: Date,
  dateEnd: Date,
): Promise<{ totals: ConsigRow; detalle: ConsigDetalleRow[] }> {
  const [totals, detalle, noteRows] = await Promise.all([
    dataSource.query<ConsigRow[]>(
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
    ),
    dataSource.query<ConsigDetalleRow[]>(
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
    ),
    dataSource.query<TransferNoteRow[]>(
      `
      WITH tp AS (
        SELECT
          si.id AS invoice_id,
          COALESCE(sp.bank_name, 'Sin especificar') AS bank_name,
          SUM(sp.amount) AS bank_amt
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
            WHERE sc.sale_invoice_id = si.id AND sc.company_id = $1
          )
          AND NOT EXISTS (
            SELECT 1 FROM sale_payments spc
            WHERE spc.sale_invoice_id = si.id AND spc.company_id = $1
              AND spc.is_voided = false AND spc.payment_method = 'CASH'
          )
        GROUP BY si.id, COALESCE(sp.bank_name, 'Sin especificar')
      ),
      na AS (
        SELECT
          cn.sale_invoice_id AS invoice_id,
          SUM(CASE WHEN cn.note_type = 'DEBIT' THEN cn.total ELSE -cn.total END) AS total_adj,
          SUM(CASE WHEN cn.note_type = 'DEBIT' THEN COALESCE(lc.cost, 0) ELSE -COALESCE(lc.cost, 0) END) AS cost_adj
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
      ),
      tp_share AS (
        SELECT
          tp.invoice_id,
          tp.bank_name,
          tp.bank_amt / NULLIF(SUM(tp.bank_amt) OVER (PARTITION BY tp.invoice_id), 0) AS share
        FROM tp
      )
      SELECT
        tp_share.bank_name,
        COALESCE(SUM(na.total_adj * tp_share.share), 0)::float AS adj,
        COALESCE(SUM(na.cost_adj * tp_share.share), 0)::float AS cost_adj
      FROM tp_share
      INNER JOIN na ON na.invoice_id = tp_share.invoice_id
      GROUP BY tp_share.bank_name
      `,
      [cid, dateStart, dateEnd],
    ),
  ]);

  return computeNetConsignaciones(
    totals[0] ?? { consig_total: 0, consig_cost: 0 },
    detalle,
    noteRows,
  );
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
        COUNT(*) AS new_credits_count,
        -- Valor/ganancia/costo DEVENGADOS del crédito, CONSOLIDADOS neto de notas
        -- (NC resta, ND suma) — una venta a crédito anulada/editada vía notas
        -- refleja su valor NETO, igual que el Reporte de Ventas. El crédito cuenta
        -- por el total de la venta (los abonos iniciales van a "Recaudo de cartera").
        COALESCE(SUM(si.total + COALESCE(na.total_adj, 0)), 0)::float AS new_credits_total,
        COALESCE(SUM(sc.balance), 0)::float AS pending_balance,
        COALESCE(SUM((si.total + COALESCE(na.total_adj, 0)) - (si.cost + COALESCE(na.cost_adj, 0))), 0)::float AS new_credits_profit,
        COALESCE(SUM(si.cost + COALESCE(na.cost_adj, 0)), 0)::float AS new_credits_cost
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
    [cid, dateStart, dateEnd],
  );
  return (
    rows[0] ?? {
      new_credits_count: 0,
      new_credits_total: 0,
      pending_balance: 0,
      new_credits_profit: 0,
      new_credits_cost: 0,
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

/**
 * Abonos a transportistas del día (tabla `carrier_payments`, por fecha del pago).
 * Solo informativo como SALIDA de caja: NO resta de la ganancia (el flete ya está
 * capitalizado en el COSTO del producto; restarlo aquí lo doble-contaría, igual
 * que los abonos a compras). Misma query que usa `extended-summary`.
 */
export async function fetchCarrierPaymentsTotal(
  dataSource: DataSource,
  cid: string,
  dateStart: Date,
  dateEnd: Date,
): Promise<number> {
  const rows = await dataSource.query<{ abonos: number }[]>(
    `
      SELECT COALESCE(SUM(cp.amount), 0)::float AS abonos
      FROM carrier_payments cp
      WHERE cp.company_id = $1
        AND cp.created_at BETWEEN $2 AND $3
      `,
    [cid, dateStart, dateEnd],
  );
  return Number(rows[0]?.abonos ?? 0);
}

/** Fila cruda de venta agregada por hora del día (hora Colombia). */
export interface SalesByHourRow {
  hour: number;
  total: number;
  count: number;
}

/**
 * Venta del día agregada por HORA (0–23) en zona `America/Bogota`. Suma el total
 * de las facturas de venta (`ticket_type = 'SALE'`, incluye contado y crédito;
 * el crédito es una venta) por la hora local en que se hicieron. Devuelve solo
 * las horas CON ventas (dispersa); el zero-fill a 24 horas lo hace la acción.
 *
 * La hora se extrae convirtiendo el `timestamptz` a hora local colombiana
 * (`AT TIME ZONE 'America/Bogota'`), no UTC, para que el pico de ventas coincida
 * con la hora de pared del negocio.
 */
export async function fetchSalesByHour(
  dataSource: DataSource,
  cid: string,
  dateStart: Date,
  dateEnd: Date,
): Promise<SalesByHourRow[]> {
  const rows = await dataSource.query<SalesByHourRow[]>(
    `
      SELECT
        EXTRACT(HOUR FROM (COALESCE(si.sold_at, si.created_at) AT TIME ZONE 'America/Bogota'))::int AS hour,
        COALESCE(SUM(si.total), 0)::float AS total,
        COUNT(*)::int AS count
      FROM sale_invoices si
      WHERE si.company_id = $1
        AND si.is_deleted = false
        AND si.ticket_type = 'SALE'
        AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
      GROUP BY hour
      ORDER BY hour
      `,
    [cid, dateStart, dateEnd],
  );
  return rows.map((r) => ({
    hour: Number(r.hour),
    total: Number(r.total),
    count: Number(r.count),
  }));
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
