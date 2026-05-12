import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { PaymentItemDto } from '../dto/payment-response.dto';
import type { ListPaymentsQueryDto, PaymentKind } from '../dto/list-payments-query.dto';

/**
 * Resultado del agregador.
 */
export interface ListAllPaymentsResult {
  items: PaymentItemDto[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Forma "ancha" del row del UNION antes de mapearse al DTO.
 */
interface RawPaymentRow {
  kind: PaymentKind;
  payment_id: string;
  reference_id: string;
  reference_number: string | null;
  counterparty_id: string | null;
  counterparty_name: string | null;
  payment_method: 'CASH' | 'TRANSFER';
  amount: string;
  change_amount: string | null;
  account_type: string | null;
  account_id: string | null;
  bank_name: string | null;
  notes: string | null;
  uuid: string | null;
  created_by: string | null;
  created_at: Date;
}

/**
 * Lista todos los pagos (sale + purchase) de la company en una sola vista
 * paginable.
 *
 * --------------------------------------------------------------------------
 * Diseño SQL
 * --------------------------------------------------------------------------
 *
 *   - UNION ALL entre `sale_payments` y `purchase_payments`. Las dos tablas
 *     tienen shapes ligeramente distintos:
 *       - `sale_payments`: account_type, account_id, change_amount, sin notes.
 *       - `purchase_payments`: source_type, source_id, notes, sin change_amount.
 *     Homogeneizamos en el SELECT con `NULL::text AS ...` etc.
 *
 *   - JOINs:
 *       sale_payments → sale_invoices: obtener ticket_number/sale_number y
 *       customer_id/customer_name.
 *       purchase_payments → purchases: obtener purchase_number y
 *       supplier_id/supplier_name.
 *
 *   - **Multi-tenancy** (CRÍTICO): filtro `company_id = $1` en CADA rama.
 *     NUNCA omitir en una rama del UNION.
 *
 *   - Filtros opcionales se aplican solo a la rama que tenga sentido. Si
 *     `customer_id` viene, solo se aplica a sales; idem `supplier_id` a
 *     purchases.
 *
 *   - Total = subquery COUNT(*) envolviendo el UNION antes de paginar.
 *
 *   - Paginación: `ORDER BY created_at DESC` (cubierto por índices
 *     `(company_id, created_at DESC)` ya existentes en ambas tablas) +
 *     LIMIT/OFFSET.
 *
 * --------------------------------------------------------------------------
 * Performance
 * --------------------------------------------------------------------------
 *
 *   - Sin N+1: los JOINs traen reference_number y counterparty_name en la
 *     misma query.
 *
 *   - Índices existentes:
 *       sale_payments: `(company_id, created_at DESC)`.
 *       purchase_payments: `(company_id, created_at DESC)`.
 *
 *     Cubren el caso por defecto. Filtros por customer/supplier usan los
 *     índices FK de las tablas padre (`sale_invoices.customer_id`,
 *     `purchases.supplier_id`).
 */
@Injectable()
export class ListAllPaymentsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, query: ListPaymentsQueryDto): Promise<ListAllPaymentsResult> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const kind = query.type ?? null;

    const params: unknown[] = [String(companyId)];
    const placeholder = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const saleWhere: string[] = [`sp.company_id = $1`];
    const purchaseWhere: string[] = [`pp.company_id = $1`];

    if (query.customer_id !== undefined) {
      const ph = placeholder(String(query.customer_id));
      saleWhere.push(`si.customer_id = ${ph}`);
    }
    if (query.supplier_id !== undefined) {
      const ph = placeholder(String(query.supplier_id));
      purchaseWhere.push(`p.supplier_id = ${ph}`);
    }
    if (query.date_from) {
      const ph = placeholder(`${query.date_from}T00:00:00.000Z`);
      saleWhere.push(`sp.created_at >= ${ph}::timestamptz`);
      purchaseWhere.push(`pp.created_at >= ${ph}::timestamptz`);
    }
    if (query.date_to) {
      const ph = placeholder(`${query.date_to}T23:59:59.999Z`);
      saleWhere.push(`sp.created_at <= ${ph}::timestamptz`);
      purchaseWhere.push(`pp.created_at <= ${ph}::timestamptz`);
    }

    const salePart = `
      SELECT
        'sale'::text AS kind,
        sp.id::text AS payment_id,
        sp.sale_invoice_id::text AS reference_id,
        COALESCE(si.sale_number, si.ticket_number) AS reference_number,
        si.customer_id::text AS counterparty_id,
        si.customer_name AS counterparty_name,
        sp.payment_method AS payment_method,
        sp.amount::text AS amount,
        sp.change_amount::text AS change_amount,
        sp.account_type AS account_type,
        sp.account_id::text AS account_id,
        sp.bank_name AS bank_name,
        NULL::text AS notes,
        sp.uuid AS uuid,
        sp.created_by AS created_by,
        sp.created_at AS created_at
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON si.id = sp.sale_invoice_id
       AND si.company_id = sp.company_id
      WHERE ${saleWhere.join(' AND ')}
    `;

    const purchasePart = `
      SELECT
        'purchase'::text AS kind,
        pp.id::text AS payment_id,
        pp.purchase_id::text AS reference_id,
        p.purchase_number AS reference_number,
        p.supplier_id::text AS counterparty_id,
        p.supplier_name AS counterparty_name,
        pp.payment_method AS payment_method,
        pp.amount::text AS amount,
        NULL::text AS change_amount,
        pp.source_type AS account_type,
        pp.source_id::text AS account_id,
        pp.bank_name AS bank_name,
        pp.notes AS notes,
        pp.uuid AS uuid,
        pp.created_by AS created_by,
        pp.created_at AS created_at
      FROM purchase_payments pp
      INNER JOIN purchases p
        ON p.id = pp.purchase_id
       AND p.company_id = pp.company_id
      WHERE ${purchaseWhere.join(' AND ')}
    `;

    let body: string;
    if (kind === 'sale') {
      body = salePart;
    } else if (kind === 'purchase') {
      body = purchasePart;
    } else {
      body = `${salePart}\nUNION ALL\n${purchasePart}`;
    }

    const countSql = `SELECT COUNT(*)::int AS count FROM (${body}) u`;
    const dataSql = `
      ${body}
      ORDER BY created_at DESC
      LIMIT ${Number(limit)}
      OFFSET ${Number(offset)}
    `;

    const countResult = await this.dataSource.query<Array<{ count: number }>>(countSql, params);
    const total = countResult[0]?.count ?? 0;

    const rows = await this.dataSource.query<RawPaymentRow[]>(dataSql, params);
    const items: PaymentItemDto[] = rows.map((r) => ({
      kind: r.kind,
      payment_id: Number(r.payment_id),
      reference_id: Number(r.reference_id),
      reference_number: r.reference_number,
      counterparty_id: r.counterparty_id !== null ? Number(r.counterparty_id) : null,
      counterparty_name: r.counterparty_name,
      payment_method: r.payment_method,
      amount: Number(r.amount),
      change_amount: r.change_amount !== null ? Number(r.change_amount) : null,
      account_type: r.account_type,
      account_id: r.account_id !== null ? Number(r.account_id) : null,
      bank_name: r.bank_name,
      notes: r.notes,
      uuid: r.uuid,
      created_by: r.created_by,
      created_at: r.created_at.toISOString(),
    }));

    return { items, total, limit, offset };
  }
}
