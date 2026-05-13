import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import type { DashboardSalesQueryDto } from '../dto/sales-report-query.dto';
import {
  calcMargin,
  calcProfit,
  groupNotes,
  round2,
  toIsoStr,
  zeroBig,
  type NoteRow,
} from '../internal/sales-report-shared';

interface DashboardInvoiceRow {
  id: string;
  ticket_type: string;
  ticket_number: string;
  sale_number: string | null;
  original_total: number;
  original_cost: number;
  customer_name: string | null;
  created_by: string | null;
  is_deleted: boolean;
  created_at: Date;
  consolidated_total: number;
  consolidated_cost: number;
  notes_count: string | number;
  note_types: string | null;
}

export interface DashboardSalesResult {
  tickets: unknown[];
  summary: {
    total_sales_count: number;
    total_orders_count: number;
    total_voided_count: number;
    total_partial_void_count: number;
    total_debit_note_count: number;
    total_revenue: number;
    total_cost: number;
    total_profit: number;
    average_margin: number;
  };
}

interface NoteFilterClause {
  sql: string;
  extraParams: unknown[];
}

/**
 * `GET /pos-reports/dashboard-sales`. Espejo PlacePos
 * `POSReportController.salesReport` con consolidación inline.
 *
 * Multi-tenancy: filtros `company_id = $1` en cada subquery — invoice,
 * credit_notes (3 subqueries para consolidated_total/cost/note_types) y
 * notes-fetch.
 */
@Injectable()
export class GetDashboardSalesAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, filters: DashboardSalesQueryDto): Promise<DashboardSalesResult> {
    if (!filters.dateFrom || !filters.dateTo) {
      throw new BadRequestException('dateFrom y dateTo son requeridos');
    }

    const dateFrom = new Date(`${filters.dateFrom}T00:00:00.000Z`);
    const dateTo = new Date(`${filters.dateTo}T23:59:59.999Z`);
    const cid = String(companyId);

    // Build invoice query with multi-tenant filters baked in.
    const params: unknown[] = [cid, dateFrom, dateTo];
    const noteFilterClause = this.buildNoteFilterClause(filters, params);

    const invoiceSql = `
      SELECT
        si.id::text AS id,
        si.ticket_type::text AS ticket_type,
        si.ticket_number,
        si.sale_number,
        si.total::float AS original_total,
        si.cost::float AS original_cost,
        si.customer_name,
        si.created_by,
        si.is_deleted,
        si.created_at,
        ROUND(
          si.total
          - COALESCE((
              SELECT SUM(cn2.total) FROM credit_notes cn2
              WHERE cn2.sale_invoice_id = si.id
                AND cn2.company_id = $1
                AND cn2.is_deleted = false
                AND cn2.note_type = 'CREDIT'
            ), 0)
          + COALESCE((
              SELECT SUM(cn2.total) FROM credit_notes cn2
              WHERE cn2.sale_invoice_id = si.id
                AND cn2.company_id = $1
                AND cn2.is_deleted = false
                AND cn2.note_type = 'DEBIT'
            ), 0)
        , 2)::float AS consolidated_total,
        ROUND(
          si.cost
          - COALESCE((
              SELECT SUM(cnl.unit_cost * cnl.quantity)
              FROM credit_notes cn2
              JOIN credit_note_lines cnl
                ON cnl.credit_note_id = cn2.id
               AND cnl.company_id = $1
              WHERE cn2.sale_invoice_id = si.id
                AND cn2.company_id = $1
                AND cn2.is_deleted = false
                AND cn2.note_type = 'CREDIT'
            ), 0)
          + COALESCE((
              SELECT SUM(cnl.unit_cost * cnl.quantity)
              FROM credit_notes cn2
              JOIN credit_note_lines cnl
                ON cnl.credit_note_id = cn2.id
               AND cnl.company_id = $1
              WHERE cn2.sale_invoice_id = si.id
                AND cn2.company_id = $1
                AND cn2.is_deleted = false
                AND cn2.note_type = 'DEBIT'
            ), 0)
        , 2)::float AS consolidated_cost,
        (
          SELECT COUNT(*) FROM credit_notes cn2
          WHERE cn2.sale_invoice_id = si.id
            AND cn2.company_id = $1
            AND cn2.is_deleted = false
        ) AS notes_count,
        (
          SELECT STRING_AGG(DISTINCT cn2.operation_type::text, ',')
          FROM credit_notes cn2
          WHERE cn2.sale_invoice_id = si.id
            AND cn2.company_id = $1
            AND cn2.is_deleted = false
        ) AS note_types
      FROM sale_invoices si
      WHERE si.company_id = $1
        AND si.created_at BETWEEN $2 AND $3
        ${noteFilterClause.sql}
      ORDER BY si.created_at DESC
    `;

    const invoiceRows = await this.dataSource.query<DashboardInvoiceRow[]>(invoiceSql, params);

    const invoiceIds = new Set<number>(invoiceRows.map((r) => Number(r.id)));
    const noteRows = await this.dataSource.query<NoteRow[]>(
      `
      SELECT
        cn.id::text AS id,
        cn.note_number,
        cn.note_type::text AS note_type,
        cn.operation_type::text AS operation_type,
        cn.sale_invoice_id::text AS sale_invoice_id,
        cn.total::float AS total,
        cn.created_by,
        cn.created_at,
        si.ticket_number AS parent_ticket_number,
        si.sale_number AS parent_sale_number,
        si.customer_name,
        COALESCE((
          SELECT SUM(cnl.unit_cost * cnl.quantity)
          FROM credit_note_lines cnl
          WHERE cnl.credit_note_id = cn.id
            AND cnl.company_id = $1
        ), 0)::float AS note_cost
      FROM credit_notes cn
      INNER JOIN sale_invoices si
        ON si.id = cn.sale_invoice_id
       AND si.company_id = $1
      WHERE cn.company_id = $1
        AND cn.is_deleted = false
        AND cn.created_at BETWEEN $2 AND $3
      ORDER BY cn.created_at ASC
      `,
      [cid, dateFrom, dateTo],
    );

    const { byInvoice: notesByInvoice, orphans: orphanNotes } = groupNotes(noteRows, invoiceIds);

    const tickets: unknown[] = [];
    for (const inv of invoiceRows) {
      const consolidatedProfit = calcProfit(inv.consolidated_total, inv.consolidated_cost);
      const consolidatedMargin = calcMargin(inv.consolidated_total, inv.consolidated_cost);
      tickets.push({
        id: Number(inv.id),
        rowType: 'INVOICE',
        ticketType: inv.ticket_type,
        ticketNumber: inv.ticket_number,
        saleNumber: inv.sale_number,
        originalTotal: Number(inv.original_total),
        consolidatedTotal: Number(inv.consolidated_total),
        cost: Number(inv.consolidated_cost),
        profit: consolidatedProfit,
        margin: consolidatedMargin,
        customerName: inv.customer_name ?? 'CONSUMIDOR FINAL',
        createdBy: inv.created_by ?? null,
        synced: true,
        isDeleted: inv.is_deleted,
        notesCount: Number(inv.notes_count),
        noteTypes: inv.note_types,
        createdAt: toIsoStr(inv.created_at),
        noteNumber: null,
        noteType: null,
        operationType: null,
        parentInvoiceId: null,
      });

      for (const note of notesByInvoice.get(Number(inv.id)) ?? []) {
        const noteProfit = calcProfit(note.total, note.note_cost || 0);
        const noteMargin = calcMargin(note.total, note.note_cost || 0);
        tickets.push({
          id: Number(note.id),
          rowType: 'NOTE',
          ticketType: 'NOTE',
          ticketNumber: note.note_number,
          saleNumber: null,
          originalTotal: Number(note.total),
          consolidatedTotal: note.note_type === 'CREDIT' ? -Number(note.total) : Number(note.total),
          cost: Number(note.note_cost) || 0,
          profit: note.note_type === 'CREDIT' ? -noteProfit : noteProfit,
          margin: noteMargin,
          customerName: note.customer_name ?? 'CONSUMIDOR FINAL',
          createdBy: note.created_by ?? null,
          synced: true,
          isDeleted: false,
          notesCount: 0,
          noteTypes: null,
          createdAt: toIsoStr(note.created_at),
          noteNumber: note.note_number,
          noteType: note.note_type,
          operationType: note.operation_type,
          parentInvoiceId: Number(note.sale_invoice_id),
        });
      }
    }

    for (const note of orphanNotes) {
      const noteProfit = calcProfit(note.total, note.note_cost || 0);
      const noteMargin = calcMargin(note.total, note.note_cost || 0);
      tickets.push({
        id: Number(note.id),
        rowType: 'NOTE',
        ticketType: 'NOTE',
        ticketNumber: note.note_number,
        saleNumber: null,
        originalTotal: Number(note.total),
        consolidatedTotal: note.note_type === 'CREDIT' ? -Number(note.total) : Number(note.total),
        cost: Number(note.note_cost) || 0,
        profit: note.note_type === 'CREDIT' ? -noteProfit : noteProfit,
        margin: noteMargin,
        customerName: note.customer_name ?? 'CONSUMIDOR FINAL',
        createdBy: note.created_by ?? null,
        synced: true,
        isDeleted: false,
        notesCount: 0,
        noteTypes: null,
        createdAt: toIsoStr(note.created_at),
        noteNumber: note.note_number,
        noteType: note.note_type,
        operationType: note.operation_type,
        parentInvoiceId: Number(note.sale_invoice_id),
      });
    }

    const activeSales = invoiceRows.filter((r) => r.ticket_type === 'SALE' && !r.is_deleted);
    let totalRevenueBig = zeroBig();
    let totalCostBig = zeroBig();
    for (const inv of activeSales) {
      totalRevenueBig = totalRevenueBig.plus(toBig(inv.consolidated_total));
      totalCostBig = totalCostBig.plus(toBig(inv.consolidated_cost));
    }
    for (const note of orphanNotes) {
      if (note.note_type === 'CREDIT') {
        totalRevenueBig = totalRevenueBig.minus(toBig(note.total));
        totalCostBig = totalCostBig.minus(toBig(note.note_cost || 0));
      } else {
        totalRevenueBig = totalRevenueBig.plus(toBig(note.total));
        totalCostBig = totalCostBig.plus(toBig(note.note_cost || 0));
      }
    }

    const dashboardRevenue = round2(totalRevenueBig.toNumber());
    const dashboardCost = round2(totalCostBig.toNumber());
    const dashboardProfit = calcProfit(dashboardRevenue, dashboardCost);
    const dashboardMargin = calcMargin(dashboardRevenue, dashboardCost);

    const summary = {
      total_sales_count: activeSales.length,
      total_orders_count: invoiceRows.filter((r) => r.ticket_type === 'ORDER' && !r.is_deleted)
        .length,
      total_voided_count: invoiceRows.filter((r) => r.is_deleted).length,
      total_partial_void_count: invoiceRows.filter(
        (r) => r.note_types?.includes('PARTIAL_VOID') && !r.is_deleted,
      ).length,
      total_debit_note_count: invoiceRows.filter(
        (r) => r.note_types?.includes('ADDITION') && !r.is_deleted,
      ).length,
      total_revenue: dashboardRevenue,
      total_cost: dashboardCost,
      total_profit: dashboardProfit,
      average_margin: dashboardMargin,
    };

    return { tickets, summary };
  }

  /**
   * Construye el predicado adicional según `noteFilter`. Devuelve SQL y los
   * parámetros extra (en el orden en que se appendarán al array compartido).
   */
  private buildNoteFilterClause(
    filters: DashboardSalesQueryDto,
    params: unknown[],
  ): NoteFilterClause {
    // Helper to append a param and get its placeholder.
    const placeholder = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (filters.noteFilter === 'ACTIVE_ONLY') {
      return {
        sql: `AND si.is_deleted = false AND NOT EXISTS (
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
        )`,
        extraParams: [],
      };
    }
    if (filters.noteFilter === 'VOIDED_ONLY') {
      return { sql: `AND si.is_deleted = true`, extraParams: [] };
    }
    if (filters.noteFilter === 'FULL_VOID') {
      return {
        sql: `AND EXISTS (
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
            AND cn.operation_type = 'FULL_VOID'
        )`,
        extraParams: [],
      };
    }
    if (filters.noteFilter === 'PARTIAL_VOID') {
      return {
        sql: `AND EXISTS (
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
            AND cn.operation_type = 'PARTIAL_VOID'
        )`,
        extraParams: [],
      };
    }
    if (filters.noteFilter === 'DEBIT_NOTES') {
      return {
        sql: `AND EXISTS (
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
            AND cn.note_type = 'DEBIT'
        )`,
        extraParams: [],
      };
    }
    if (filters.noteFilter === 'WITH_ADJUSTMENTS') {
      return {
        sql: `AND EXISTS (
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
        )`,
        extraParams: [],
      };
    }
    if (!filters.showDeleted) {
      const fromPh = placeholder(params[1]);
      const toPh = placeholder(params[2]);
      return {
        sql: `AND (si.is_deleted = false OR EXISTS (
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
            AND cn.created_at BETWEEN ${fromPh} AND ${toPh}
        ))`,
        extraParams: [],
      };
    }
    return { sql: '', extraParams: [] };
  }
}
