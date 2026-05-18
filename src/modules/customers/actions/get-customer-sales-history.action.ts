import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Customer } from '@/modules/customers/entities/customer.entity';

import { findCustomerInCompany } from '../internal/customer-lookups';

/**
 * Shape de respuesta del endpoint `GET /customers/:id/sales-history`.
 *
 * Espejo PlacePos:
 *   {
 *     customer_id,
 *     invoices: [ { id, sale_number|ticket_number, ticket_type, created_at,
 *                  total, cost, profit, margin, payment_method, is_credit,
 *                  credit_status?, credit_balance?, products: string[] } ],
 *     summary:  { count, total, profit, margin_avg }
 *   }
 *
 * Totales consolidados con NC/ND (+ DEBIT − CREDIT). El payment_method se
 * resuelve por agregación de `sale_payments` (si todos son CASH → CASH, si
 * todos TRANSFER → TRANSFER, si mixtos → MIXED, si no hay pagos → null).
 *
 * `products` se concatena en SQL con `string_agg(description, '||')` para
 * minimizar payloads, espejando PlacePos. El frontend hace `split('||')`.
 */
export interface CustomerSalesHistoryInvoice {
  id: number;
  sale_number: string | null;
  ticket_number: string;
  ticket_type: string;
  created_at: string;
  total: number;
  cost: number;
  profit: number;
  margin: number;
  payment_method: string | null;
  is_credit: boolean;
  credit_status: string | null;
  credit_balance: number | null;
  products: string[];
}

export interface CustomerSalesHistoryResponse {
  customer_id: number;
  invoices: CustomerSalesHistoryInvoice[];
  summary: {
    count: number;
    total: number;
    profit: number;
    margin_avg: number;
  };
}

/**
 * Devuelve el histórico completo de ventas del cliente con consolidación NC/ND,
 * info de crédito y nombres de productos concatenados.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * TODOS los JOINS (`sale_invoices`, `sale_invoice_lines`, `credit_notes`,
 * `sale_credits`, `sale_payments`) filtran por `company_id`. Sin filtros
 * cross-tenant, un cliente cuyo ID exista en dos companies vería ventas
 * mezcladas. Defensa en profundidad — el filtro principal sobre
 * `sale_invoices.customer_id + company_id` ya impone tenancy, pero los JOINS
 * la repiten para que el optimizador use los índices compuestos.
 */
@Injectable()
export class GetCustomerSalesHistoryAction {
  constructor(
    @InjectRepository(Customer)
    private readonly repo: Repository<Customer>,
  ) {}

  async execute(id: number, companyId: number): Promise<CustomerSalesHistoryResponse> {
    // Pre-validar existencia + tenancy.
    await findCustomerInCompany(this.repo.manager, id, companyId);

    const rows: Array<{
      id: string;
      sale_number: string | null;
      ticket_number: string;
      ticket_type: string;
      created_at: Date;
      total: string;
      cost: string;
      total_credit: string;
      total_debit: string;
      payment_method: string | null;
      is_credit: boolean;
      credit_status: string | null;
      credit_balance: string | null;
      products_concat: string | null;
    }> = await this.repo.query(
      `
      WITH base AS (
        SELECT si.id,
               si.sale_number,
               si.ticket_number,
               si.ticket_type,
               si.created_at,
               si.total,
               si.cost
          FROM sale_invoices si
         WHERE si.company_id = $1
           AND si.customer_id = $2
           AND si.is_deleted = false
      ),
      notes_agg AS (
        SELECT cn.sale_invoice_id AS id,
               SUM(CASE WHEN cn.note_type = 'CREDIT' THEN cn.total ELSE 0 END) AS total_credit,
               SUM(CASE WHEN cn.note_type = 'DEBIT'  THEN cn.total ELSE 0 END) AS total_debit
          FROM credit_notes cn
         WHERE cn.company_id = $1
           AND cn.is_deleted = false
         GROUP BY cn.sale_invoice_id
      ),
      payments_agg AS (
        SELECT sp.sale_invoice_id AS id,
               CASE
                 WHEN COUNT(DISTINCT sp.payment_method) = 0 THEN NULL
                 WHEN COUNT(DISTINCT sp.payment_method) = 1 THEN MIN(sp.payment_method::text)
                 ELSE 'MIXED'
               END AS payment_method
          FROM sale_payments sp
         WHERE sp.company_id = $1
         GROUP BY sp.sale_invoice_id
      ),
      credit_agg AS (
        SELECT sc.sale_invoice_id AS id,
               sc.status::text     AS credit_status,
               sc.balance          AS credit_balance
          FROM sale_credits sc
         WHERE sc.company_id = $1
      ),
      products_agg AS (
        SELECT sil.sale_invoice_id AS id,
               string_agg(sil.description, '||' ORDER BY sil.id) AS products_concat
          FROM sale_invoice_lines sil
         WHERE sil.company_id = $1
         GROUP BY sil.sale_invoice_id
      )
      SELECT b.id,
             b.sale_number,
             b.ticket_number,
             b.ticket_type::text AS ticket_type,
             b.created_at,
             b.total,
             b.cost,
             COALESCE(n.total_credit, 0) AS total_credit,
             COALESCE(n.total_debit, 0)  AS total_debit,
             p.payment_method,
             (c.id IS NOT NULL)          AS is_credit,
             c.credit_status,
             c.credit_balance,
             pr.products_concat
        FROM base b
        LEFT JOIN notes_agg   n  ON n.id  = b.id
        LEFT JOIN payments_agg p ON p.id  = b.id
        LEFT JOIN credit_agg  c  ON c.id  = b.id
        LEFT JOIN products_agg pr ON pr.id = b.id
       ORDER BY b.created_at DESC
      `,
      [String(companyId), String(id)],
    );

    const invoices: CustomerSalesHistoryInvoice[] = rows.map((r) => {
      const total = toBig(r.total).plus(toBig(r.total_debit)).minus(toBig(r.total_credit));
      const cost = toBig(r.cost);
      const profit = total.minus(cost);
      const margin = total.gt(0) ? profit.div(total).times(100) : toBig(0);

      return {
        id: Number(r.id),
        sale_number: r.sale_number,
        ticket_number: r.ticket_number,
        ticket_type: r.ticket_type,
        created_at: new Date(r.created_at).toISOString(),
        total: preciseNumber(total, 2),
        cost: preciseNumber(cost, 2),
        profit: preciseNumber(profit, 2),
        margin: preciseNumber(margin, 4),
        payment_method: r.payment_method,
        is_credit: Boolean(r.is_credit),
        credit_status: r.credit_status,
        credit_balance: r.credit_balance !== null ? Number(r.credit_balance) : null,
        products:
          r.products_concat && r.products_concat.length > 0 ? r.products_concat.split('||') : [],
      };
    });

    // Summary agregado del lado server. count = invoices.length.
    let sumTotal = toBig(0);
    let sumProfit = toBig(0);
    let marginAcc = toBig(0);
    for (const inv of invoices) {
      sumTotal = sumTotal.plus(toBig(inv.total));
      sumProfit = sumProfit.plus(toBig(inv.profit));
      marginAcc = marginAcc.plus(toBig(inv.margin));
    }
    const marginAvg = invoices.length > 0 ? marginAcc.div(invoices.length) : toBig(0);

    return {
      customer_id: id,
      invoices,
      summary: {
        count: invoices.length,
        total: preciseNumber(sumTotal, 2),
        profit: preciseNumber(sumProfit, 2),
        margin_avg: preciseNumber(marginAvg, 4),
      },
    };
  }
}
