import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Customer } from '@/modules/customers/entities/customer.entity';

import { findCustomerInCompany } from '../internal/customer-lookups';

/**
 * Shape de respuesta del endpoint `GET /customers/:id/sales-chart`. Espejo
 * PlacePos:
 *
 *   {
 *     customer_id,
 *     startDate, endDate,
 *     points: [ { date, total, profit, margin } ]
 *   }
 *
 * `points` SIEMPRE incluye TODOS los días del rango (con 0/0/0 cuando no hay
 * ventas) gracias a `generate_series`. Necesario para que el frontend dibuje
 * un eje X uniforme.
 */
export interface CustomerSalesChartResponse {
  customer_id: number;
  startDate: string;
  endDate: string;
  points: { date: string; total: number; profit: number; margin: number }[];
}

/**
 * Shape de respuesta del endpoint `GET /customers/:id/product-history`.
 *
 * Espejo PlacePos: últimas 20 facturas del cliente (ORDER + SALE) con sus
 * líneas. Lineas con `quantity * unit_price` ya consolidado por la action
 * (no devolvemos sale_invoice_line raw — devolvemos el shape que espera el
 * frontend).
 */
export interface CustomerProductHistoryResponse {
  customer_id: number;
  lines: Array<{
    invoice_id: number;
    sale_number: string | null;
    ticket_number: string;
    created_at: string;
    product_name: string;
    quantity: number;
    price: number;
    total: number;
  }>;
}

/**
 * Parsea/normaliza el rango de fechas que PlacePos acepta como query string.
 *
 *   - `startDate` y `endDate` opcionales en formato YYYY-MM-DD.
 *   - Sin `endDate`: hoy (UTC).
 *   - Sin `startDate`: endDate - 30 días.
 *   - Si `startDate > endDate`: 400.
 */
function parseChartRange(
  startDate?: string,
  endDate?: string,
): { startDate: string; endDate: string } {
  const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

  if (startDate !== undefined && !DATE_REGEX.test(startDate)) {
    throw new BadRequestException('Rango de fechas inválido');
  }
  if (endDate !== undefined && !DATE_REGEX.test(endDate)) {
    throw new BadRequestException('Rango de fechas inválido');
  }

  const now = new Date();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const resolvedEnd = endDate ?? todayLocal;

  let resolvedStart: string;
  if (startDate) {
    resolvedStart = startDate;
  } else {
    const base = new Date(`${resolvedEnd}T00:00:00`);
    base.setDate(base.getDate() - 30);
    resolvedStart = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  }

  if (resolvedStart > resolvedEnd) {
    throw new BadRequestException('Rango de fechas inválido');
  }

  return { startDate: resolvedStart, endDate: resolvedEnd };
}

@Injectable()
export class GetCustomerChartsAction {
  constructor(
    @InjectRepository(Customer)
    private readonly repo: Repository<Customer>,
  ) {}

  /**
   * Serie temporal de total/profit/margin diaria. Usa `generate_series` para
   * asegurar que los días sin venta aparezcan como 0. La consolidación con
   * notas crédito/débito se hace en una CTE:
   *
   *   - Ventas activas (`sale_invoices.is_deleted = false`) cuentan al total.
   *   - Sumas de `credit_notes.total` se restan al día de la NC si
   *     `note_type = 'CREDIT'`.
   *   - Sumas de `credit_notes.total` se SUMAN si `note_type = 'DEBIT'`.
   *
   * margin = total > 0 ? (profit / total) * 100 : 0.
   *
   * Multi-tenancy: TODOS los SELECTs filtran por `company_id`. Sin él, un
   * cliente de otra company que comparta `customer_id` introduciría fuga.
   */
  async getSalesChart(
    id: number,
    companyId: number,
    startDate?: string,
    endDate?: string,
  ): Promise<CustomerSalesChartResponse> {
    await findCustomerInCompany(this.repo.manager, id, companyId);
    const range = parseChartRange(startDate, endDate);

    const cidParam = String(companyId);
    const customerParam = String(id);

    // El generate_series usa `::date` para que coincida con el agrupado por
    // día. Hacemos LEFT JOIN para que los días sin ventas devuelvan 0.
    //
    // Ventas y notas se agrupan por fecha y luego se cruza con la serie.
    const rows: Array<{
      day: string;
      total_sales: string | null;
      cost_sales: string | null;
      total_credit: string | null;
      total_debit: string | null;
    }> = await this.repo.query(
      `
      WITH days AS (
        SELECT generate_series(
          $1::date,
          $2::date,
          interval '1 day'
        )::date AS day
      ),
      sales AS (
        SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
               SUM(total)::numeric AS total_sales,
               SUM(cost)::numeric  AS cost_sales
          FROM sale_invoices
         WHERE company_id = $3
           AND customer_id = $4
           AND is_deleted = false
           AND (created_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
         GROUP BY 1
      ),
      credit_notes_agg AS (
        SELECT (cn.created_at AT TIME ZONE 'UTC')::date AS day,
               SUM(CASE WHEN cn.note_type = 'CREDIT' THEN cn.total ELSE 0 END)::numeric AS total_credit,
               SUM(CASE WHEN cn.note_type = 'DEBIT'  THEN cn.total ELSE 0 END)::numeric AS total_debit
          FROM credit_notes cn
          JOIN sale_invoices si
            ON si.id = cn.sale_invoice_id
           AND si.company_id = cn.company_id
         WHERE cn.company_id = $3
           AND si.customer_id = $4
           AND cn.is_deleted = false
           AND (cn.created_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
         GROUP BY 1
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
             COALESCE(s.total_sales, 0)  AS total_sales,
             COALESCE(s.cost_sales, 0)   AS cost_sales,
             COALESCE(c.total_credit, 0) AS total_credit,
             COALESCE(c.total_debit, 0)  AS total_debit
        FROM days d
        LEFT JOIN sales s ON s.day = d.day
        LEFT JOIN credit_notes_agg c ON c.day = d.day
       ORDER BY d.day ASC
      `,
      [range.startDate, range.endDate, cidParam, customerParam],
    );

    const points = rows.map((r) => {
      const totalSales = toBig(r.total_sales ?? 0);
      const costSales = toBig(r.cost_sales ?? 0);
      const credit = toBig(r.total_credit ?? 0);
      const debit = toBig(r.total_debit ?? 0);

      // Consolidación: + DEBIT, - CREDIT.
      const total = totalSales.plus(debit).minus(credit);
      const profit = total.minus(costSales);
      const margin = total.gt(0) ? profit.div(total).times(100) : toBig(0);

      return {
        date: r.day,
        total: preciseNumber(total, 2),
        profit: preciseNumber(profit, 2),
        margin: preciseNumber(margin, 4),
      };
    });

    return {
      customer_id: id,
      startDate: range.startDate,
      endDate: range.endDate,
      points,
    };
  }

  /**
   * Últimas 20 facturas del cliente con sus líneas. Espejo PlacePos. Se hace
   * UNA query con LATERAL para asegurar que las líneas vengan agrupadas por
   * factura sin generar N+1.
   *
   * Multi-tenancy: ambos `sale_invoices.company_id` y
   * `sale_invoice_lines.company_id` se filtran.
   */
  async getProductHistory(id: number, companyId: number): Promise<CustomerProductHistoryResponse> {
    await findCustomerInCompany(this.repo.manager, id, companyId);

    const rows: Array<{
      invoice_id: string;
      sale_number: string | null;
      ticket_number: string;
      created_at: Date;
      product_name: string;
      quantity: string;
      unit_price: string;
      total: string;
    }> = await this.repo.query(
      `
      WITH last_invoices AS (
        SELECT id, sale_number, ticket_number, created_at
          FROM sale_invoices
         WHERE company_id = $1
           AND customer_id = $2
           AND is_deleted = false
         ORDER BY created_at DESC
         LIMIT 20
      )
      SELECT li.id                AS invoice_id,
             li.sale_number       AS sale_number,
             li.ticket_number     AS ticket_number,
             li.created_at        AS created_at,
             l.description        AS product_name,
             l.quantity           AS quantity,
             l.unit_price         AS unit_price,
             l.total              AS total
        FROM last_invoices li
        JOIN sale_invoice_lines l
          ON l.sale_invoice_id = li.id
         AND l.company_id = $1
       ORDER BY li.created_at DESC, l.id ASC
      `,
      [String(companyId), String(id)],
    );

    return {
      customer_id: id,
      lines: rows.map((r) => ({
        invoice_id: Number(r.invoice_id),
        sale_number: r.sale_number,
        ticket_number: r.ticket_number,
        created_at: new Date(r.created_at).toISOString(),
        product_name: r.product_name,
        quantity: Number(r.quantity),
        price: Number(r.unit_price),
        total: Number(r.total),
      })),
    };
  }
}
