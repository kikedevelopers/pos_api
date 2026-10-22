import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';
import { toBig } from '@/common/utils/precision';

/**
 * Compras por pagar del dashboard (cuentas por pagar a proveedores).
 *
 * Una compra está "por pagar" cuando su `purchase_credits` no está `PAID` y
 * conserva saldo. El archivado de una compra salda su credit (PAID, balance 0),
 * así que el universo coincide con `fetchSupplierDebt` (tarjeta "Deuda con
 * proveedores"); además se excluyen compras soft-deleted por defensa.
 *
 * Orden: la que vence primero arriba (`payment_due_at ASC`); las vencidas
 * quedan naturalmente al tope. Las compras sin plazo van al final, de la más
 * antigua a la más nueva.
 *
 * Tramos (`totals`), con el mismo criterio que el front (`now > payment_due_at`
 * = vencida; el vencimiento ya está guardado como fin del día en Bogotá):
 *   - `overdue`:  payment_due_at <  now
 *   - `due_soon`: now <= payment_due_at < inicio del día (hoy + DUE_SOON_DAYS) Bogotá,
 *                 es decir, vence en los próximos DUE_SOON_DAYS días contando hoy
 *   - `upcoming`: payment_due_at >= ese límite
 *   - `no_due`:   payment_due_at IS NULL
 *
 * Los totales se calculan sobre TODO el universo; `items` se limita a `limit`.
 *
 * Multi-tenancy: `pc.company_id = $1` y `p.company_id = $1` (defensa en
 * profundidad). SELECT puro — no requiere transacción.
 */

/** Ventana (días calendario, hoy incluido) del tramo "vence pronto". */
export const PAYABLES_DUE_SOON_DAYS = 7;
export const PAYABLES_DEFAULT_LIMIT = 10;

export interface PayableItem {
  purchase_id: number;
  purchase_number: string;
  supplier_id: number;
  supplier_name: string;
  invoice_number: string | null;
  invoice_date: string | null;
  payment_due_at: string | null;
  total: number;
  paid: number;
  balance: number;
}

export interface PayablesBucket {
  count: number;
  balance: number;
}

export interface PayablesResult {
  items: PayableItem[];
  totals: PayablesBucket & {
    overdue: PayablesBucket;
    due_soon: PayablesBucket;
    upcoming: PayablesBucket;
    no_due: PayablesBucket;
  };
  due_soon_days: number;
}

interface ItemRow {
  id: string;
  purchase_number: string;
  supplier_id: string;
  supplier_name: string;
  invoice_number: string | null;
  invoice_date: Date | string | null;
  payment_due_at: Date | string | null;
  total: string;
  paid: string;
  balance: string;
}

interface TotalsRow {
  count: number | string;
  balance: string;
  overdue_count: number | string;
  overdue_balance: string;
  due_soon_count: number | string;
  due_soon_balance: string;
  upcoming_count: number | string;
  upcoming_balance: string;
  no_due_count: number | string;
  no_due_balance: string;
}

const round2 = (value: unknown): number => Number(toBig(value).round(2).toString());

const bucket = (count: unknown, balance: unknown): PayablesBucket => ({
  count: Number(count ?? 0),
  balance: round2(balance ?? 0),
});

const toIso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

// `invoice_date` es `date`: se expone como día plano, sin desfase de zona.
const toDay = (value: Date | string | null): string | null => {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  return dayjs(value).format('YYYY-MM-DD');
};

const UNPAID_WHERE = `
  pc.company_id = $1
  AND p.company_id = $1
  AND pc.status <> 'PAID'
  AND pc.balance > 0
  AND p.is_deleted = false
`;

@Injectable()
export class GetPayablesAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    companyId: number,
    limit: number = PAYABLES_DEFAULT_LIMIT,
    now: Date = new Date(),
  ): Promise<PayablesResult> {
    const company = String(companyId);
    const soonLimit = dayjs(now)
      .tz(APP_TIMEZONE)
      .startOf('day')
      .add(PAYABLES_DUE_SOON_DAYS, 'day')
      .toDate();

    const [itemRows, totalsRows] = await Promise.all([
      this.dataSource.query<ItemRow[]>(
        `
        SELECT p.id, p.purchase_number, p.supplier_id, p.supplier_name,
               p.invoice_number, p.invoice_date, p.payment_due_at,
               pc.total_amount::text AS total,
               pc.paid_amount::text AS paid,
               pc.balance::text AS balance
        FROM purchase_credits pc
        INNER JOIN purchases p ON p.id = pc.purchase_id
        WHERE ${UNPAID_WHERE}
        ORDER BY p.payment_due_at ASC NULLS LAST, p.created_at ASC, p.id ASC
        LIMIT $2
        `,
        [company, limit],
      ),
      this.dataSource.query<TotalsRow[]>(
        `
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(pc.balance), 0)::text AS balance,
          COUNT(*) FILTER (WHERE p.payment_due_at < $2) AS overdue_count,
          COALESCE(SUM(pc.balance) FILTER (WHERE p.payment_due_at < $2), 0)::text AS overdue_balance,
          COUNT(*) FILTER (WHERE p.payment_due_at >= $2 AND p.payment_due_at < $3) AS due_soon_count,
          COALESCE(SUM(pc.balance) FILTER (WHERE p.payment_due_at >= $2 AND p.payment_due_at < $3), 0)::text AS due_soon_balance,
          COUNT(*) FILTER (WHERE p.payment_due_at >= $3) AS upcoming_count,
          COALESCE(SUM(pc.balance) FILTER (WHERE p.payment_due_at >= $3), 0)::text AS upcoming_balance,
          COUNT(*) FILTER (WHERE p.payment_due_at IS NULL) AS no_due_count,
          COALESCE(SUM(pc.balance) FILTER (WHERE p.payment_due_at IS NULL), 0)::text AS no_due_balance
        FROM purchase_credits pc
        INNER JOIN purchases p ON p.id = pc.purchase_id
        WHERE ${UNPAID_WHERE}
        `,
        [company, now, soonLimit],
      ),
    ]);

    const t = totalsRows[0];
    return {
      items: itemRows.map((r) => ({
        purchase_id: Number(r.id),
        purchase_number: r.purchase_number,
        supplier_id: Number(r.supplier_id),
        supplier_name: r.supplier_name,
        invoice_number: r.invoice_number,
        invoice_date: toDay(r.invoice_date),
        payment_due_at: toIso(r.payment_due_at),
        total: round2(r.total),
        paid: round2(r.paid),
        balance: round2(r.balance),
      })),
      totals: {
        ...bucket(t?.count, t?.balance),
        overdue: bucket(t?.overdue_count, t?.overdue_balance),
        due_soon: bucket(t?.due_soon_count, t?.due_soon_balance),
        upcoming: bucket(t?.upcoming_count, t?.upcoming_balance),
        no_due: bucket(t?.no_due_count, t?.no_due_balance),
      },
      due_soon_days: PAYABLES_DUE_SOON_DAYS,
    };
  }
}
