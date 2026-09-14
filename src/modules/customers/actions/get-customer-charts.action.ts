import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';

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
    productName: string;
    quantity: number;
    price: number;
    profit: number;
    margin: number;
    ticketNumber: string;
    // Factura de origen: id para abrir el TicketViewer y fecha/hora de la venta.
    invoiceId: number;
    createdAt: string;
    // Tipo de factura para diferenciar visualmente Pedido vs Venta.
    ticketType: 'SALE' | 'ORDER';
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
    // El mismo flag que decide si los pedidos cuentan como ingreso en los
    // informes. Fijar el criterio aquí haría que la gráfica del cliente y el
    // informe de ventas contaran cosas distintas del mismo negocio.
    private readonly getIncludeOrdersInReports: GetIncludeOrdersInReportsAction,
  ) {}

  /**
   * Serie temporal de total/profit/margin diaria. Usa `generate_series` para
   * asegurar que los días sin venta aparezcan como 0.
   *
   * Cada venta se imputa a SU día por su CONSOLIDADO (venta ± sus notas), que
   * es la regla de todos los informes. Antes se hacía en dos CTEs separadas y
   * de ahí salían tres errores:
   *
   *   - la venta anulada se excluía por `is_deleted` pero su nota de anulación
   *     se seguía restando, así que el día quedaba en NEGATIVO: el cliente
   *     aparecía comprando menos que nada;
   *   - el ajuste se cargaba al día de la NOTA, no al de la venta, y movía
   *     dinero de un día a otro;
   *   - el costo no se ajustaba con la nota, así que la ganancia del día salía
   *     inflada aunque el total estuviera bien.
   *
   * El ajuste sale de `v_sale_note_adjustments`, la misma vista que usan los
   * demás informes, para que no vuelva a haber dos maneras de sumar lo mismo.
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
    const { enabled: includeOrders } = await this.getIncludeOrdersInReports.execute(companyId);

    // El generate_series usa `::date` para que coincida con el agrupado por
    // día. Hacemos LEFT JOIN para que los días sin ventas devuelvan 0.
    //
    // Ventas y notas se agrupan por fecha y luego se cruza con la serie.
    const rows: Array<{
      day: string;
      total_sales: string | null;
      cost_sales: string | null;
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
        SELECT (si.created_at AT TIME ZONE 'UTC')::date AS day,
               SUM(si.total + COALESCE(adj.total_adjustment, 0))::numeric AS total_sales,
               SUM(si.cost  + COALESCE(adj.cost_adjustment, 0))::numeric  AS cost_sales
          FROM sale_invoices si
          LEFT JOIN v_sale_note_adjustments adj
                 ON adj.sale_invoice_id = si.id
                AND adj.company_id = si.company_id
         WHERE si.company_id = $3
           AND si.customer_id = $4
           AND (si.ticket_type = 'SALE' OR ($5::boolean AND si.ticket_type = 'ORDER'))
           -- La anulada entra SOLO si lleva su nota, que la deja en cero. Sin
           -- este par de condiciones el día salía negativo.
           AND (si.is_deleted = false OR COALESCE(adj.notes_count, 0) > 0)
           AND (si.created_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
         GROUP BY 1
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
             COALESCE(s.total_sales, 0)  AS total_sales,
             COALESCE(s.cost_sales, 0)   AS cost_sales
        FROM days d
        LEFT JOIN sales s ON s.day = d.day
       ORDER BY d.day ASC
      `,
      [range.startDate, range.endDate, cidParam, customerParam, includeOrders],
    );

    const points = rows.map((r) => {
      // El total ya viene consolidado desde la consulta, y el costo también:
      // así la ganancia del día corresponde a lo que de verdad quedó vendido.
      const total = toBig(r.total_sales ?? 0);
      const costSales = toBig(r.cost_sales ?? 0);

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
      ticket_number: string;
      product_name: string;
      quantity: string;
      unit_price: string;
      profit: string;
      margin: string;
      invoice_id: number | string;
      created_at: string | Date;
      ticket_type: 'SALE' | 'ORDER';
    }> = await this.repo.query(
      `
      WITH last_invoices AS (
        SELECT id, sale_number, ticket_number, ticket_type, created_at
          FROM sale_invoices
         WHERE company_id = $1
           AND customer_id = $2
           AND is_deleted = false
         ORDER BY created_at DESC
         LIMIT 20
      )
      SELECT COALESCE(li.sale_number, li.ticket_number) AS ticket_number,
             l.description        AS product_name,
             l.quantity           AS quantity,
             l.unit_price         AS unit_price,
             l.profit             AS profit,
             l.margin             AS margin,
             li.id                AS invoice_id,
             li.created_at        AS created_at,
             li.ticket_type       AS ticket_type
        FROM last_invoices li
        JOIN sale_invoice_lines l
          ON l.sale_invoice_id = li.id
         AND l.company_id = $1
       ORDER BY li.created_at DESC, l.id ASC
      `,
      [String(companyId), String(id)],
    );

    // Shape camelCase espejo de PlacePos (`customers.routes.ts`): el frontend del
    // POS espera productName/profit/margin/ticketNumber. Antes se devolvía
    // snake_case sin profit/margin, por eso esas columnas salían vacías.
    return {
      customer_id: id,
      lines: rows.map((r) => ({
        productName: r.product_name,
        quantity: Number(r.quantity),
        price: Number(r.unit_price),
        profit: Number(r.profit),
        margin: Number(r.margin),
        ticketNumber: r.ticket_number,
        invoiceId: Number(r.invoice_id),
        createdAt: new Date(r.created_at).toISOString(),
        ticketType: r.ticket_type,
      })),
    };
  }
}
