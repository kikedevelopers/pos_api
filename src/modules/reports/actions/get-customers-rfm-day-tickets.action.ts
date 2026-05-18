import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

interface DayTicketRow {
  id: number;
  ticket_number: string;
  sale_number: string | null;
  total: number;
  cost: number;
  profit: number;
  created_at: Date | string;
  has_notes: boolean;
}

export interface CustomersRfmDayTicket {
  id: number;
  ticketNumber: string;
  saleNumber: string | null;
  total: number;
  cost: number;
  profit: number;
  createdAt: string;
  hasNotes: boolean;
}

export interface CustomersRfmDayTicketsResult {
  tickets: CustomersRfmDayTicket[];
}

/**
 * `GET /reports/customers-rfm/day-tickets?customerId=&date=`.
 *
 * Espejo PlacePos `reports.routes.ts:872-936`. Drill-down: lista los tickets
 * `SALE` no eliminados de un cliente en un día específico. El frontend abre
 * `TicketViewer` con cada `id` resultante.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * `sale_invoices.company_id = $1` Y `customer_id = $2`. La subconsulta
 * `EXISTS(... credit_notes cn ...)` también filtra por `cn.company_id = $1`,
 * pues por convención cada NC vive en la misma company que su venta — pero
 * incluso si por bug una NC apunta a una venta de otra company, el filtro
 * impide que se "incrimine" el ticket actual con notas de otro tenant.
 *
 * Nota: la validación de existencia del `customer_id` para la company NO se
 * hace aquí (PlacePos no la hace). Si el cliente no existe en la company
 * devolvemos `tickets: []`, lo cual es coherente y no filtra información.
 */
@Injectable()
export class GetCustomersRfmDayTicketsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    companyId: number,
    customerId: number,
    date: string,
  ): Promise<CustomersRfmDayTicketsResult> {
    const dateStart = new Date(`${date}T00:00:00.000Z`);
    const dateEnd = new Date(`${date}T23:59:59.999Z`);
    const cid = String(companyId);
    const cust = String(customerId);

    const rows = await this.dataSource.query<DayTicketRow[]>(
      `
      SELECT
        si.id::int AS id,
        si.ticket_number,
        si.sale_number,
        si.total::float AS total,
        si.cost::float AS cost,
        si.profit::float AS profit,
        si.created_at,
        EXISTS(
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
        ) AS has_notes
      FROM sale_invoices si
      WHERE si.company_id = $1
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
        AND si.customer_id = $2
        AND si.created_at BETWEEN $3 AND $4
      ORDER BY si.created_at ASC
      `,
      [cid, cust, dateStart, dateEnd],
    );

    const tickets: CustomersRfmDayTicket[] = rows.map((r) => ({
      id: Number(r.id),
      ticketNumber: r.ticket_number,
      saleNumber: r.sale_number,
      total: Number(r.total),
      cost: Number(r.cost),
      profit: Number(r.profit),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      hasNotes: Boolean(r.has_notes),
    }));

    return { tickets };
  }
}
