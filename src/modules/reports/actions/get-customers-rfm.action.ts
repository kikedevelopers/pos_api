import { BadRequestException, Injectable } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import { isValidDateString, todayUtcDate } from '../internal/range';

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface CustomerRfmDailyRow {
  customer_id: number;
  customer_name: string;
  phone: string | null;
  doc_number: string | null;
  date: string;
  day_total: number;
  day_cost: number;
  ticket_count: number;
}

export interface CustomerRfmDayBreakdown {
  date: string;
  total: number;
  cost: number;
  ticketCount: number;
}

export interface CustomerRfm {
  customerId: number;
  customerName: string;
  phone: string | null;
  docNumber: string | null;
  purchaseDates: number;
  ticketCount: number;
  lastPurchaseDate: string;
  daysSinceLast: number;
  avgPeriodDays: number | null;
  overdue: boolean;
  totalAmount: number;
  totalCost: number;
  totalProfit: number;
  totalMargin: number;
  dailyBreakdown: CustomerRfmDayBreakdown[];
}

export interface CustomersRfmResult {
  from: string;
  to: string;
  referenceDate: string;
  customers: CustomerRfm[];
}

/**
 * Shape paginado del resultado. Solo se devuelve cuando el cliente pidió
 * paginación explícita (`limit` y/o `offset` en query). Si NO los envió, el
 * action devuelve `CustomersRfmResult` legacy con TODOS los clientes —
 * paridad PlacePos por default.
 */
export interface CustomersRfmPaginatedResult {
  from: string;
  to: string;
  referenceDate: string;
  items: CustomerRfm[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Filtros opcionales de paginación. Si AMBOS son `undefined` el caller
 * recibe el shape legacy; si CUALQUIERA llega definido el caller recibe el
 * shape paginado (con defaults `limit=100`, `offset=0`).
 */
export interface CustomersRfmPagination {
  limit?: number;
  offset?: number;
}

interface Bucket {
  customerId: number;
  customerName: string;
  phone: string | null;
  docNumber: string | null;
  days: CustomerRfmDayBreakdown[];
  totalAmount: Big;
  totalCost: Big;
  ticketCount: number;
}

// ─── Constantes de rango ──────────────────────────────────────────────────────

/**
 * Espejo PlacePos `reports.routes.ts:690`. RFM permite hasta ~3 años porque el
 * análisis es retrospectivo. Excede el `MAX_RANGE_DAYS=366` del helper común,
 * por eso no usamos `parseUtcRange` aquí.
 */
const MAX_RFM_RANGE_DAYS = 1100;
const DEFAULT_RFM_WINDOW_DAYS = 90;

const round2 = (n: unknown): number => Number(toBig(n).round(2).toString());

function subtractDaysUtc(dateIso: string, days: number): string {
  const ms = new Date(`${dateIso}T00:00:00.000Z`).getTime() - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function diffDaysUtc(a: string, b: string): number {
  const start = new Date(`${a}T00:00:00.000Z`).getTime();
  const end = new Date(`${b}T00:00:00.000Z`).getTime();
  return Math.floor((end - start) / 86_400_000);
}

/**
 * `GET /reports/customers-rfm?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 *
 * Espejo PlacePos `reports.routes.ts:669-855`. Análisis RFM (Recency,
 * Frequency, Monetary) de clientes:
 *   - Recency: `daysSinceLast` desde `referenceDate` (=`to`).
 *   - Frequency: `purchaseDates` (días distintos con compra) y `ticketCount`.
 *   - Monetary: `totalAmount` consolidado (VENTA + ND − NC) en el rango.
 *
 * Una sola query con dos CTEs:
 *   1. `note_aggregates`: agrega NC/ND por venta original (multi-tenant).
 *   2. `consolidated`: por cada venta SALE no eliminada con `customer_id`,
 *      computa `(total + debits − credits)` y `(cost + debit_cost − credit_cost)`.
 *   Luego agrupa por `(customer, date_utc)`.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * Cada referencia a `sale_invoices`, `credit_notes`, `credit_note_lines` y
 * `customers` filtra por `company_id = $1`. Cross-tenant impossible:
 *   - El driver acepta `$1` como string para bigint, lo que evita el cast
 *     numérico que perdería precisión > 2^53.
 *   - Si un atacante manipula NC/ND de su propia company para apuntar a una
 *     `sale_invoice_id` de OTRA company, el join `cn.sale_invoice_id = si.id
 *     AND si.company_id = $1` la descarta en silencio (el filtro de FK ya lo
 *     debería bloquear al CREATE, pero defensa en profundidad).
 */
@Injectable()
export class GetCustomersRfmAction {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Sobrecargas:
   *   - Sin `pagination`           → shape legacy `CustomersRfmResult`.
   *   - Con `pagination` (parcial) → shape paginado con defaults
   *     `limit=100`, `offset=0`.
   *
   * El shape se decide por presencia del 4to argumento — paridad PlacePos por
   * default. Cliente nuevo opta-in pasando query `?limit=…` o `?offset=…`.
   */
  async execute(
    companyId: number,
    fromInput?: string,
    toInput?: string,
  ): Promise<CustomersRfmResult>;
  async execute(
    companyId: number,
    fromInput: string | undefined,
    toInput: string | undefined,
    pagination: CustomersRfmPagination,
  ): Promise<CustomersRfmPaginatedResult>;
  async execute(
    companyId: number,
    fromInput?: string,
    toInput?: string,
    pagination?: CustomersRfmPagination,
  ): Promise<CustomersRfmResult | CustomersRfmPaginatedResult> {
    const toStr = toInput ?? todayUtcDate();
    const fromStr = fromInput ?? subtractDaysUtc(toStr, DEFAULT_RFM_WINDOW_DAYS);

    if (!isValidDateString(fromStr) || !isValidDateString(toStr)) {
      throw new BadRequestException('Formato de fecha inválido (YYYY-MM-DD)');
    }
    if (toStr < fromStr) {
      throw new BadRequestException('"to" no puede ser anterior a "from"');
    }
    const rangeDays = diffDaysUtc(fromStr, toStr) + 1;
    if (rangeDays > MAX_RFM_RANGE_DAYS) {
      throw new BadRequestException(`Rango máximo permitido: ${MAX_RFM_RANGE_DAYS} días (~3 años)`);
    }

    const dateStart = new Date(`${fromStr}T00:00:00.000Z`);
    const dateEnd = new Date(`${toStr}T23:59:59.999Z`);
    const cid = String(companyId);

    const rows = await this.dataSource.query<CustomerRfmDailyRow[]>(
      `
      WITH note_aggregates AS (
        SELECT
          cn.sale_invoice_id AS original_invoice_id,
          COALESCE(SUM(CASE WHEN cn.note_type='DEBIT'  THEN cn.total ELSE 0 END), 0) AS debit_total,
          COALESCE(SUM(CASE WHEN cn.note_type='CREDIT' THEN cn.total ELSE 0 END), 0) AS credit_total,
          COALESCE(SUM(CASE WHEN cn.note_type='DEBIT' THEN (
            SELECT COALESCE(SUM(cnl.unit_cost * cnl.quantity), 0)
            FROM credit_note_lines cnl
            WHERE cnl.credit_note_id = cn.id
              AND cnl.company_id = $1
          ) ELSE 0 END), 0) AS debit_cost,
          COALESCE(SUM(CASE WHEN cn.note_type='CREDIT' THEN (
            SELECT COALESCE(SUM(cnl.unit_cost * cnl.quantity), 0)
            FROM credit_note_lines cnl
            WHERE cnl.credit_note_id = cn.id
              AND cnl.company_id = $1
          ) ELSE 0 END), 0) AS credit_cost
        FROM credit_notes cn
        WHERE cn.company_id = $1
          AND cn.is_deleted = false
        GROUP BY cn.sale_invoice_id
      ),
      consolidated AS (
        SELECT
          si.id,
          si.customer_id,
          TO_CHAR(si.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS date,
          (si.total + COALESCE(na.debit_total, 0) - COALESCE(na.credit_total, 0))::float AS total,
          (si.cost  + COALESCE(na.debit_cost, 0)  - COALESCE(na.credit_cost, 0))::float  AS cost
        FROM sale_invoices si
        LEFT JOIN note_aggregates na ON na.original_invoice_id = si.id
        WHERE si.company_id = $1
          AND si.ticket_type = 'SALE'
          AND si.is_deleted = false
          AND si.customer_id IS NOT NULL
          AND si.created_at BETWEEN $2 AND $3
      )
      SELECT
        c.id::int AS customer_id,
        c.name AS customer_name,
        c.phone,
        c.doc_number,
        cs.date,
        SUM(cs.total)::float AS day_total,
        SUM(cs.cost)::float AS day_cost,
        COUNT(*)::int AS ticket_count
      FROM consolidated cs
      INNER JOIN customers c
        ON c.id = cs.customer_id
       AND c.company_id = $1
      GROUP BY c.id, c.name, c.phone, c.doc_number, cs.date
      ORDER BY c.id, cs.date DESC
      `,
      [cid, dateStart, dateEnd],
    );

    const byCustomer = new Map<number, Bucket>();
    for (const row of rows) {
      const existing = byCustomer.get(row.customer_id);
      const bucket: Bucket = existing ?? {
        customerId: row.customer_id,
        customerName: row.customer_name,
        phone: row.phone,
        docNumber: row.doc_number,
        days: [],
        totalAmount: new Big(0),
        totalCost: new Big(0),
        ticketCount: 0,
      };
      const dayTotal = Number(row.day_total);
      const dayCost = Number(row.day_cost);
      const dayTickets = Number(row.ticket_count);
      bucket.days.push({
        date: row.date,
        total: dayTotal,
        cost: dayCost,
        ticketCount: dayTickets,
      });
      bucket.totalAmount = bucket.totalAmount.plus(toBig(dayTotal));
      bucket.totalCost = bucket.totalCost.plus(toBig(dayCost));
      bucket.ticketCount += dayTickets;
      byCustomer.set(row.customer_id, bucket);
    }

    const customers: CustomerRfm[] = Array.from(byCustomer.values()).map((b) => {
      // `days` viene DESC; clonamos ASC para diferencias consecutivas.
      const asc = [...b.days].sort((x, y) => x.date.localeCompare(y.date));
      const lastDate = asc[asc.length - 1].date;
      const firstDate = asc[0].date;
      const daysSinceLast = Math.max(0, diffDaysUtc(lastDate, toStr));

      let avgPeriodDays: number | null = null;
      if (asc.length >= 2) {
        const totalSpan = diffDaysUtc(firstDate, lastDate);
        avgPeriodDays = round2(totalSpan / (asc.length - 1));
      }

      const overdue =
        avgPeriodDays !== null && avgPeriodDays > 0 && daysSinceLast > avgPeriodDays * 1.5;

      const totalAmount = round2(b.totalAmount.toNumber());
      const totalCost = round2(b.totalCost.toNumber());
      const totalProfit = round2(b.totalAmount.minus(b.totalCost).toNumber());
      const totalMargin =
        totalAmount > 0 ? round2(toBig(totalProfit).div(totalAmount).times(100).toNumber()) : 0;

      return {
        customerId: b.customerId,
        customerName: b.customerName,
        phone: b.phone,
        docNumber: b.docNumber,
        purchaseDates: b.days.length,
        ticketCount: b.ticketCount,
        lastPurchaseDate: lastDate,
        daysSinceLast,
        avgPeriodDays,
        overdue,
        totalAmount,
        totalCost,
        totalProfit,
        totalMargin,
        dailyBreakdown: b.days.map((d) => ({
          date: d.date,
          total: round2(d.total),
          cost: round2(d.cost),
          ticketCount: d.ticketCount,
        })),
      };
    });

    customers.sort((a, b) => b.totalAmount - a.totalAmount);

    // Shape decision: si el caller pasó `pagination` → paginar; si no →
    // shape legacy (paridad PlacePos byte-a-byte).
    if (pagination !== undefined) {
      const limit = pagination.limit ?? 100;
      const offset = pagination.offset ?? 0;
      const items = customers.slice(offset, offset + limit);
      return {
        from: fromStr,
        to: toStr,
        referenceDate: toStr,
        items,
        total: customers.length,
        limit,
        offset,
      };
    }

    return {
      from: fromStr,
      to: toStr,
      referenceDate: toStr,
      customers,
    };
  }
}
