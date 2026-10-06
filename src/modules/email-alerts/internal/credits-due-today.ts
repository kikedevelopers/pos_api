import type { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

/** Una fila del reporte "créditos que vencen hoy". */
export interface CreditDueTodayRow {
  customerName: string;
  ticketNumber: string;
  /** Fecha en que se registró la venta (YYYY-MM-DD, hora Colombia). */
  saleDate: string;
  /** Nombre de quién registró la venta (cajero/usuario). */
  registeredBy: string;
  totalAmount: number;
  paidAmount: number;
  balance: number;
  /** Fecha de vencimiento del crédito (YYYY-MM-DD). */
  dueDate: string;
}

export interface CreditsDueTodaySummary {
  date: string;
  rows: CreditDueTodayRow[];
  count: number;
  totalBalance: number;
}

interface RawRow {
  customer_name: string;
  ticket_number: string;
  sale_date: string;
  registered_by: string;
  total_amount: number;
  paid_amount: number;
  balance: number;
  due_date: string;
}

const round2 = (n: unknown): number => Number(toBig(n).round(2).toString());

/**
 * Créditos con saldo > 0 cuya fecha de vencimiento (`due_date`) es EXACTAMENTE
 * `date` (YYYY-MM-DD, hora Colombia — `date` ya viene resuelto por quien llama).
 * Mismo criterio que el Reporte de Cartera, pero `= date` en vez de `< today`
 * (eso sería "vencido"). Multi-tenant: filtra `company_id = $1` en cada tabla.
 */
export async function fetchCreditsDueToday(
  dataSource: DataSource,
  companyId: number,
  date: string,
): Promise<CreditsDueTodaySummary> {
  const raw = await dataSource.query<RawRow[]>(
    `
    SELECT
      COALESCE(si.customer_name, 'CONSUMIDOR FINAL') AS customer_name,
      si.ticket_number,
      TO_CHAR(COALESCE(si.sold_at, si.created_at) AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS sale_date,
      COALESCE(NULLIF(btrim(si.created_by), ''), '—') AS registered_by,
      sc.total_amount::float AS total_amount,
      sc.paid_amount::float  AS paid_amount,
      sc.balance::float      AS balance,
      TO_CHAR(sc.due_date, 'YYYY-MM-DD') AS due_date
    FROM sale_credits sc
    INNER JOIN sale_invoices si
      ON si.id = sc.sale_invoice_id
     AND si.company_id = $1
    WHERE sc.company_id = $1
      AND sc.balance > 0
      AND sc.due_date = $2::date
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
    ORDER BY sc.balance DESC
    `,
    [String(companyId), date],
  );

  const rows: CreditDueTodayRow[] = raw.map((r) => ({
    customerName: r.customer_name,
    ticketNumber: r.ticket_number,
    saleDate: r.sale_date,
    registeredBy: r.registered_by,
    totalAmount: round2(r.total_amount),
    paidAmount: round2(r.paid_amount),
    balance: round2(r.balance),
    dueDate: r.due_date,
  }));

  const totalBalance = round2(
    rows.reduce((acc, r) => acc.plus(toBig(r.balance)), toBig(0)).toNumber(),
  );

  return { date, rows, count: rows.length, totalBalance };
}
