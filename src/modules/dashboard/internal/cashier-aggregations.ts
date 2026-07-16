import Big from 'big.js';
import type { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

/**
 * Agregaciones SQL específicas del endpoint `GET /dashboard/today-by-cashier`.
 *
 * Cada query filtra `company_id = $1` en TODA tabla involucrada (sale_invoices,
 * sale_payments, credit_notes, credit_note_lines, sale_credits, users).
 * Espejo PlacePos pero adaptado a los nombres de columnas del cloud:
 *
 *   - `sp.sale_invoice_id` (cloud) ↔ `sp.invoice_id` (PlacePos local).
 *   - `sp.amount` (cloud) ↔ `sp.amount_paid` (PlacePos local).
 *   - `cn.sale_invoice_id` (cloud) ↔ `cn.original_invoice_id` (PlacePos local).
 *   - `cnl.unit_cost` (cloud) ↔ `cnl.cost` (PlacePos local).
 *
 * Todas las queries son SELECT puros — sin transacción.
 */

export interface CashierSalesRow {
  user_id: number | null;
  user_name: string;
  cash_total: number;
  transfer_total: number;
}

export interface CashierProfitRow {
  user_id: number | null;
  // Utilidad de contado DEVENGADA, PRORRATEADA por método de pago de la venta
  // (para el desglose Efectivo/Consignación con su ganancia). cash+transfer = si.profit.
  cash_profit: number;
  transfer_profit: number;
}

export interface CashierNotesRow {
  user_id: number | null;
  user_name: string;
  note_type: 'CREDIT' | 'DEBIT';
  cash_total: number;
  transfer_total: number;
  // Utilidad de la nota PRORRATEADA por método (para el desglose por método).
  cash_profit: number;
  transfer_profit: number;
}

export interface CashierAbonosRow {
  user_id: number | null;
  user_name: string;
  cash_total: number;
  transfer_total: number;
}

export interface CashierNewCreditsRow {
  user_id: number | null;
  user_name: string;
  count: string | number;
  amount: number;
  // Ganancia DEVENGADA del crédito generado por el cajero (proporcional a lo
  // financiado). Base del bloque "Ventas" del cajero (una venta a crédito es venta).
  profit: number;
}

interface CashierCreditPaymentBreakdownRow {
  user_id: number | null;
  amount_paid: number;
  consolidated_total: number;
  consolidated_cost: number;
}

interface CashierSalesCountRow {
  user_id: number | null;
  count: string | number;
}

/**
 * Pagos a ventas regulares (no a invoices con crédito) agrupados por cajero y
 * método. `LEAST(sp.amount, si.total)` evita inflar con el vuelto.
 *
 * Recaudo = dinero recibido en el rango → se filtra por `sp.created_at` (fecha
 * del PAGO), igual que `fetchPaymentsTotal(onlyCredits=false)` de `/dashboard/
 * today`. Así el "Total Recaudado" por cajero cuadra con el consolidado. La
 * ATRIBUCIÓN sigue siendo `si.created_by_id` (el vendedor de la factura), no el
 * cajero que tomó el pago — mismo criterio previo. La GANANCIA por cajero
 * (`fetchSalesProfitByCashier`), las notas, los créditos nuevos y el conteo de
 * ventas se reconocen por `COALESCE(si.sold_at, si.created_at)` (el día en que
 * la venta se realizó/cobró), en paridad con las agregaciones de `/dashboard/today`.
 */
export async function fetchSalesByCashier(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<CashierSalesRow[]> {
  return dataSource.query<CashierSalesRow[]>(
    `
    SELECT
      si.created_by_id::bigint AS user_id,
      COALESCE(
        NULLIF(TRIM(BOTH FROM CONCAT_WS(' ', u.name, u.lastname)), ''),
        si.created_by,
        'Sin asignar'
      ) AS user_name,
      COALESCE(SUM(CASE WHEN sp.payment_method = 'CASH' THEN LEAST(sp.amount, si.total) ELSE 0 END), 0)::float AS cash_total,
      COALESCE(SUM(CASE WHEN sp.payment_method = 'TRANSFER' THEN LEAST(sp.amount, si.total) ELSE 0 END), 0)::float AS transfer_total
    FROM sale_payments sp
    INNER JOIN sale_invoices si
      ON sp.sale_invoice_id = si.id
     AND si.company_id = $1
    LEFT JOIN users u ON u.id = si.created_by_id
    WHERE sp.company_id = $1
      AND sp.is_voided = false
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND sp.created_at BETWEEN $2 AND $3
      AND NOT EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = si.id
          AND sc.company_id = $1
      )
    GROUP BY si.created_by_id, user_name
    `,
    [String(companyId), dateStart, dateEnd],
  );
}

/**
 * Utilidad de contado por cajero, PRORRATEADA por método de pago de cada venta
 * (Efectivo/Consignación) para poder mostrar la ganancia y el margen de cada
 * método en el desglose del cajero. Solo invoices NO-crédito.
 *
 * La utilidad íntegra de cada venta (`si.profit`) se reparte entre los métodos
 * en proporción a lo pagado con cada uno (`cash_amt/total_paid`,
 * `transfer_amt/total_paid`), igual que se prorratean las notas. La suma
 * `cash_profit + transfer_profit` = `si.profit` de la venta (cuando se pagó con
 * contado, sin anticipos). No hay JOIN directo a payments en el SELECT de
 * `si.profit` (el split va en un CTE agregado por factura) para no duplicar.
 */
export async function fetchSalesProfitByCashier(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<CashierProfitRow[]> {
  return dataSource.query<CashierProfitRow[]>(
    `
    WITH payment_split AS (
      SELECT
        sp.sale_invoice_id,
        SUM(CASE WHEN sp.payment_method = 'CASH' THEN LEAST(sp.amount, si.total) ELSE 0 END) AS cash_amt,
        SUM(CASE WHEN sp.payment_method = 'TRANSFER' THEN LEAST(sp.amount, si.total) ELSE 0 END) AS transfer_amt,
        NULLIF(SUM(LEAST(sp.amount, si.total)), 0) AS total_paid
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON si.id = sp.sale_invoice_id
       AND si.company_id = $1
      WHERE sp.company_id = $1
        AND sp.is_voided = false
      GROUP BY sp.sale_invoice_id
    )
    SELECT
      si.created_by_id::bigint AS user_id,
      COALESCE(SUM(si.profit * COALESCE(ps.cash_amt / ps.total_paid, 0)), 0)::float AS cash_profit,
      COALESCE(SUM(si.profit * COALESCE(ps.transfer_amt / ps.total_paid, 0)), 0)::float AS transfer_profit
    FROM sale_invoices si
    LEFT JOIN payment_split ps ON ps.sale_invoice_id = si.id
    WHERE si.company_id = $1
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
      AND NOT EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = si.id
          AND sc.company_id = $1
      )
    GROUP BY si.created_by_id
    `,
    [String(companyId), dateStart, dateEnd],
  );
}

/**
 * Notas (CREDIT/DEBIT) prorrateadas sobre la proporción de cada método de
 * pago de la V original. Preserva la identidad cash + transfer = neto.
 */
export async function fetchNotesByCashier(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<CashierNotesRow[]> {
  return dataSource.query<CashierNotesRow[]>(
    `
    WITH note_costs AS (
      SELECT
        cn.id,
        cn.note_type,
        cn.sale_invoice_id,
        cn.created_by_id,
        cn.created_by,
        cn.total,
        COALESCE(SUM(cnl.unit_cost * cnl.quantity), 0) AS total_cost
      FROM credit_notes cn
      LEFT JOIN credit_note_lines cnl
        ON cnl.credit_note_id = cn.id
       AND cnl.company_id = $1
      WHERE cn.company_id = $1
        AND cn.is_deleted = false
      GROUP BY cn.id
    ),
    payment_split AS (
      SELECT
        sp.sale_invoice_id,
        SUM(CASE WHEN sp.payment_method = 'CASH' THEN LEAST(sp.amount, si.total) ELSE 0 END) AS cash_amt,
        SUM(CASE WHEN sp.payment_method = 'TRANSFER' THEN LEAST(sp.amount, si.total) ELSE 0 END) AS transfer_amt,
        NULLIF(SUM(LEAST(sp.amount, si.total)), 0) AS total_paid
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON si.id = sp.sale_invoice_id
       AND si.company_id = $1
      WHERE sp.company_id = $1
        AND sp.is_voided = false
      GROUP BY sp.sale_invoice_id
    )
    SELECT
      nc.created_by_id::bigint AS user_id,
      COALESCE(
        NULLIF(TRIM(BOTH FROM CONCAT_WS(' ', u.name, u.lastname)), ''),
        nc.created_by,
        'Sin asignar'
      ) AS user_name,
      nc.note_type::text AS note_type,
      COALESCE(SUM(nc.total * COALESCE(ps.cash_amt / ps.total_paid, 0)), 0)::float AS cash_total,
      COALESCE(SUM(nc.total * COALESCE(ps.transfer_amt / ps.total_paid, 0)), 0)::float AS transfer_total,
      COALESCE(SUM((nc.total - nc.total_cost) * COALESCE(ps.cash_amt / ps.total_paid, 0)), 0)::float AS cash_profit,
      COALESCE(SUM((nc.total - nc.total_cost) * COALESCE(ps.transfer_amt / ps.total_paid, 0)), 0)::float AS transfer_profit
    FROM note_costs nc
    INNER JOIN sale_invoices si
      ON si.id = nc.sale_invoice_id
     AND si.company_id = $1
    LEFT JOIN payment_split ps ON ps.sale_invoice_id = nc.sale_invoice_id
    LEFT JOIN users u ON u.id = nc.created_by_id
    WHERE si.is_deleted = false
      AND si.ticket_type = 'SALE'
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
      AND NOT EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = si.id
          AND sc.company_id = $1
      )
    GROUP BY nc.created_by_id, user_name, nc.note_type
    `,
    [String(companyId), dateStart, dateEnd],
  );
}

/**
 * Abonos a invoices a crédito agrupados por cajero del pago (no de la venta).
 * Estos son los recaudos del día por cobros de cartera.
 */
export async function fetchAbonosByCashier(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<CashierAbonosRow[]> {
  return dataSource.query<CashierAbonosRow[]>(
    `
    SELECT
      sp.created_by_id::bigint AS user_id,
      COALESCE(
        NULLIF(TRIM(BOTH FROM CONCAT_WS(' ', u.name, u.lastname)), ''),
        sp.created_by,
        'Sin asignar'
      ) AS user_name,
      COALESCE(SUM(CASE WHEN sp.payment_method = 'CASH' THEN sp.amount ELSE 0 END), 0)::float AS cash_total,
      COALESCE(SUM(CASE WHEN sp.payment_method = 'TRANSFER' THEN sp.amount ELSE 0 END), 0)::float AS transfer_total
    FROM sale_payments sp
    LEFT JOIN users u ON u.id = sp.created_by_id
    WHERE sp.company_id = $1
      AND sp.is_voided = false
      AND sp.created_at BETWEEN $2 AND $3
      AND EXISTS (
        SELECT 1 FROM sale_credits sc
        WHERE sc.sale_invoice_id = sp.sale_invoice_id
          AND sc.company_id = $1
      )
    GROUP BY sp.created_by_id, user_name
    `,
    [String(companyId), dateStart, dateEnd],
  );
}

/**
 * Profit proporcional de cada abono a invoice a crédito, agrupado por cajero
 * del pago. Devuelve un mapa userId → Big de profit acumulado.
 */
export async function fetchCreditPaymentsProfitShareByCashier(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<Map<number, Big>> {
  const rows = await dataSource.query<CashierCreditPaymentBreakdownRow[]>(
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
      sp.created_by_id::bigint AS user_id,
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

  const byUser = new Map<number, Big>();
  for (const row of rows) {
    const total = toBig(row.consolidated_total);
    if (total.lte(0)) {
      continue;
    }
    const cost = toBig(row.consolidated_cost);
    const profit = total.minus(cost);
    const amount = toBig(row.amount_paid);
    const effective = amount.lt(total) ? amount : total;
    const profitShare = effective.times(profit).div(total);
    const userId = row.user_id ?? 0;
    const acc = byUser.get(userId) ?? new Big(0);
    byUser.set(userId, acc.plus(profitShare));
  }
  return byUser;
}

/**
 * Créditos GENERADOS por cajero (sale_credits cuya invoice se creó en el
 * rango y pertenecen al actor que firmó la invoice).
 */
export async function fetchNewCreditsByCashier(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<CashierNewCreditsRow[]> {
  return dataSource.query<CashierNewCreditsRow[]>(
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
      si.created_by_id::bigint AS user_id,
      COALESCE(
        NULLIF(TRIM(BOTH FROM CONCAT_WS(' ', u.name, u.lastname)), ''),
        si.created_by,
        'Sin asignar'
      ) AS user_name,
      COUNT(*) AS count,
      -- Valor/ganancia CONSOLIDADOS (neto de notas): coherente con el Reporte de Ventas.
      COALESCE(SUM(si.total + COALESCE(na.total_adj, 0)), 0)::float AS amount,
      COALESCE(SUM((si.total + COALESCE(na.total_adj, 0)) - (si.cost + COALESCE(na.cost_adj, 0))), 0)::float AS profit
    FROM sale_credits sc
    INNER JOIN sale_invoices si
      ON si.id = sc.sale_invoice_id
     AND si.company_id = $1
    LEFT JOIN note_agg na ON na.sale_invoice_id = si.id
    LEFT JOIN users u ON u.id = si.created_by_id
    WHERE sc.company_id = $1
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
    GROUP BY si.created_by_id, user_name
    `,
    [String(companyId), dateStart, dateEnd],
  );
}

/**
 * Conteo de tickets V por cajero. Devuelve mapa userId → number.
 */
export async function fetchSalesCountByCashier(
  dataSource: DataSource,
  companyId: number,
  dateStart: Date,
  dateEnd: Date,
): Promise<Map<number, number>> {
  const rows = await dataSource.query<CashierSalesCountRow[]>(
    `
    SELECT
      si.created_by_id::bigint AS user_id,
      COUNT(*)::int AS count
    FROM sale_invoices si
    WHERE si.company_id = $1
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3
    GROUP BY si.created_by_id
    `,
    [String(companyId), dateStart, dateEnd],
  );
  const map = new Map<number, number>();
  for (const r of rows) {
    const key = r.user_id == null ? 0 : Number(r.user_id);
    map.set(key, Number(r.count));
  }
  return map;
}
