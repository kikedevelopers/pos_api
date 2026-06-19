import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Customer } from '@/modules/customers/entities/customer.entity';

import { findCustomerInCompany } from '../internal/customer-lookups';

/**
 * Estados de crédito tal como los consume el frontend de PlacePos
 * (`CreditStatus = 'PENDING' | 'PARTIAL' | 'PAID'`). OJO: el enum de
 * `sale_credits.status` en pos_api usa `PARTIALLY_PAID`, no `PARTIAL`, por lo
 * que aquí se normaliza para coincidir byte a byte con el contrato offline.
 */
export type CustomerSalesHistoryCreditStatus = 'PENDING' | 'PARTIAL' | 'PAID';

/**
 * Shape de respuesta del endpoint `GET /customers/:id/sales-history`.
 *
 * Espejo EXACTO del backend offline de PlacePos
 * (`CustomerController.ts → offline:get-customer-sales-history`). El renderer
 * de PlacePos es el mismo en modo offline y cloud, por lo que el payload DEBE
 * ser idéntico (camelCase) o el front crashea al leer `productNames`, etc.
 *
 *   {
 *     invoices: [ { id, invoiceNumber, paymentType, isPaid, creditStatus,
 *                  total, cost, profit, margin, createdAt, createdBy,
 *                  creditBalance, creditPaid, creditTotal, productNames[] } ],
 *     summary:  { salesCount, totalSales, totalProfit, totalCost, averageMargin }
 *   }
 *
 * Cifras = valores PERSISTIDOS de `sale_invoices` (total/cost/profit/margin),
 * SIN consolidar NC/ND, igual que el backend offline de PlacePos. Mantener
 * paridad de DATOS además de paridad de shape.
 *
 * `productNames` se concatena en SQL con `string_agg(description, '||')` (la
 * columna `description` de `sale_invoice_lines` es el snapshot del nombre del
 * producto, espejo del `name` offline). El frontend hace `split('||')`.
 */
export interface CustomerSalesHistoryInvoice {
  id: number;
  invoiceNumber: string;
  paymentType: 'CREDITO' | 'CONTADO';
  isPaid: boolean;
  creditStatus: CustomerSalesHistoryCreditStatus | null;
  total: number;
  cost: number;
  profit: number;
  margin: number;
  createdAt: string;
  createdBy: string;
  creditBalance: number;
  creditPaid: number;
  creditTotal: number;
  productNames: string[];
}

export interface CustomerSalesHistoryResponse {
  invoices: CustomerSalesHistoryInvoice[];
  summary: {
    salesCount: number;
    totalSales: number;
    totalProfit: number;
    totalCost: number;
    averageMargin: number;
  };
}

/**
 * Normaliza el `status` del enum de pos_api (`PARTIALLY_PAID`) al contrato
 * offline de PlacePos (`PARTIAL`). El resto de valores coincide.
 */
function normalizeCreditStatus(status: string | null): CustomerSalesHistoryCreditStatus | null {
  if (status === null) {
    return null;
  }
  if (status === 'PARTIALLY_PAID') {
    return 'PARTIAL';
  }
  return status as CustomerSalesHistoryCreditStatus;
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
      created_by: string | null;
      total: string;
      cost: string;
      profit: string;
      margin: string;
      payment_method: string | null;
      is_credit: boolean;
      credit_status: string | null;
      credit_balance: string | null;
      credit_paid: string | null;
      credit_total: string | null;
      products_concat: string | null;
    }> = await this.repo.query(
      `
      WITH base AS (
        SELECT si.id,
               si.sale_number,
               si.ticket_number,
               si.ticket_type,
               si.created_at,
               si.created_by,
               si.total,
               si.cost,
               si.profit,
               si.margin
          FROM sale_invoices si
         WHERE si.company_id = $1
           AND si.customer_id = $2
           AND si.is_deleted = false
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
           AND sp.is_voided = false
         GROUP BY sp.sale_invoice_id
      ),
      credit_agg AS (
        SELECT sc.sale_invoice_id AS id,
               sc.status::text     AS credit_status,
               sc.balance          AS credit_balance,
               sc.paid_amount      AS credit_paid,
               sc.total_amount     AS credit_total
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
             b.created_by,
             b.total,
             b.cost,
             b.profit,
             b.margin,
             p.payment_method,
             (c.id IS NOT NULL)          AS is_credit,
             c.credit_status,
             c.credit_balance,
             c.credit_paid,
             c.credit_total,
             pr.products_concat
        FROM base b
        LEFT JOIN payments_agg p ON p.id  = b.id
        LEFT JOIN credit_agg  c  ON c.id  = b.id
        LEFT JOIN products_agg pr ON pr.id = b.id
       ORDER BY b.created_at DESC
      `,
      [String(companyId), String(id)],
    );

    const invoices: CustomerSalesHistoryInvoice[] = rows.map((r) => {
      // Paridad EXACTA con el backend offline de PlacePos: se devuelven los
      // valores PERSISTIDOS de la factura (total/cost/profit/margin), SIN
      // consolidar NC/ND. El offline no consolida aquí, así que el cloud
      // tampoco — de lo contrario las cifras divergen entre modos.
      const total = toBig(r.total);
      const cost = toBig(r.cost);
      const profit = toBig(r.profit);
      const margin = toBig(r.margin);
      const isCredit = Boolean(r.is_credit);
      const creditStatus = normalizeCreditStatus(r.credit_status);

      return {
        id: Number(r.id),
        // Espejo offline: número de venta si existe, si no el ticket.
        invoiceNumber: r.sale_number || r.ticket_number,
        paymentType: isCredit ? 'CREDITO' : 'CONTADO',
        // Una venta de contado siempre está pagada; una a crédito solo cuando
        // su `status` es PAID.
        isPaid: isCredit ? r.credit_status === 'PAID' : true,
        creditStatus,
        total: preciseNumber(total, 2),
        cost: preciseNumber(cost, 2),
        profit: preciseNumber(profit, 2),
        margin: preciseNumber(margin, 4),
        createdAt: new Date(r.created_at).toISOString(),
        createdBy: r.created_by || '',
        creditBalance: r.credit_balance !== null ? Number(r.credit_balance) : 0,
        creditPaid: r.credit_paid !== null ? Number(r.credit_paid) : 0,
        creditTotal: r.credit_total !== null ? Number(r.credit_total) : 0,
        productNames:
          r.products_concat && r.products_concat.length > 0 ? r.products_concat.split('||') : [],
      };
    });

    // Summary agregado del lado server. salesCount = invoices.length.
    let sumTotal = toBig(0);
    let sumProfit = toBig(0);
    let sumCost = toBig(0);
    for (const inv of invoices) {
      sumTotal = sumTotal.plus(toBig(inv.total));
      sumProfit = sumProfit.plus(toBig(inv.profit));
      sumCost = sumCost.plus(toBig(inv.cost));
    }
    // averageMargin espeja offline: profit total / ventas totales * 100 (NO el
    // promedio de los márgenes por factura).
    const averageMargin = sumTotal.gt(0) ? sumProfit.div(sumTotal).times(100) : toBig(0);

    return {
      invoices,
      summary: {
        salesCount: invoices.length,
        totalSales: preciseNumber(sumTotal, 2),
        totalProfit: preciseNumber(sumProfit, 2),
        totalCost: preciseNumber(sumCost, 2),
        averageMargin: preciseNumber(averageMargin, 2),
      },
    };
  }
}
