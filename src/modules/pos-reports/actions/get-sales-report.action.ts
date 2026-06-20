import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { toBig } from '@/common/utils/precision';
import { parseUtcRange } from '@/modules/reports/internal/range';

import type { SalesReportQueryDto } from '../dto/sales-report-query.dto';
import {
  calcMargin,
  calcProfit,
  groupNotes,
  mapNoteToTicket,
  round2,
  toIsoStr,
  zeroBig,
  type NoteRow,
} from '../internal/sales-report-shared';

interface InvoiceRow {
  id: string;
  ticket_type: string;
  ticket_number: string;
  sale_number: string | null;
  original_total: number;
  original_cost: number;
  original_profit: number;
  original_margin: number;
  customer_name: string | null;
  created_by: string | null;
  is_deleted: boolean;
  created_at: Date;
  notes_count: string | number;
  note_types: string | null;
  is_credit: boolean;
  credit_balance: number;
  credit_status: string | null;
  // Σ(amount − change_amount) de los pagos VIVOS (is_voided = false). Permite
  // derivar el saldo pendiente de una venta de contado a la que se le reversó un
  // pago (queda como VENTA con saldo, sin pasar a crédito). Paridad placepos.
  paid_amount: number;
  // Medios de pago DISTINTOS de los pagos vivos, separados por coma
  // (p. ej. "CASH" o "CASH,TRANSFER"). null si no hay pagos vivos.
  payment_methods: string | null;
}

// Clasifica el tipo de pago de una venta a partir de los medios DISTINTOS de
// sus pagos vivos. Espejo placepos (pos-reports.routes.ts).
//   - sin pagos vivos            → 'UNDEFINED' ("Sin definir")
//   - un solo medio              → ese medio ('CASH'/'TRANSFER'/'CREDIT')
//   - dos o más medios distintos → 'MIXED' ("Mixto")
type PaymentTypeCode = 'CASH' | 'TRANSFER' | 'CREDIT' | 'MIXED' | 'UNDEFINED';

function derivePaymentType(methodsCsv: string | null): PaymentTypeCode {
  const methods = (methodsCsv ?? '').split(',').filter(Boolean);
  if (methods.length === 0) return 'UNDEFINED';
  if (methods.length > 1) return 'MIXED';
  const only = methods[0];
  if (only === 'CASH' || only === 'TRANSFER' || only === 'CREDIT') return only;
  return 'UNDEFINED';
}

export interface SalesReportResult {
  tickets: unknown[];
  summary: {
    total_sales_count: number;
    total_notes_count: number;
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

/**
 * `GET /pos-reports/sales`. Listado de tickets (invoices + notas) con filtros.
 *
 * Espejo PlacePos `POSReportController.salesReport`. La query principal
 * trae las INVOICES filtradas; las notas se fetchean en una query separada y
 * se agrupan por sale_invoice_id en memoria.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * `si.company_id = $1` Y `sc.company_id = $1` (cuando se hace LEFT JOIN con
 * sale_credits) en la query de invoices. `cn.company_id = $1` Y
 * `si.company_id = $1` en la query de notas.
 */
@Injectable()
export class GetSalesReportAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    companyId: number,
    filters: SalesReportQueryDto,
    actor: AuthUser,
  ): Promise<SalesReportResult> {
    if (!filters.dateFrom || !filters.dateTo) {
      throw new BadRequestException('dateFrom y dateTo son requeridos');
    }

    // HIGH-2 auditoría Fase 11: validar rango (`to >= from` + MAX_RANGE_DAYS).
    // Sin esto, un rango de varios años hace DoS — el endpoint no pagina y el
    // summary itera todo en memoria.
    const range = parseUtcRange(filters.dateFrom, filters.dateTo);
    const dateFrom = range.dateStart;
    const dateTo = range.dateEnd;
    const cid = String(companyId);

    const { sql, params } = this.buildInvoiceQuery(cid, filters, dateFrom, dateTo, actor);
    const invoiceRows = await this.dataSource.query<InvoiceRow[]>(sql, params);

    const invoiceIds = new Set<number>(invoiceRows.map((r) => Number(r.id)));
    const noteRows = await this.fetchNoteRows(cid, dateFrom, dateTo, actor);
    const { byInvoice: notesByInvoice, orphans: orphanNotes } = groupNotes(noteRows, invoiceIds);

    const tickets: unknown[] = [];
    for (const inv of invoiceRows) {
      tickets.push(this.mapInvoiceTicket(inv));
      const invoiceNotes = notesByInvoice.get(Number(inv.id)) ?? [];
      for (const note of invoiceNotes) {
        tickets.push(mapNoteToTicket(note));
      }
    }

    // Notas huérfanas: PlacePos las muestra cuando el filtro de tipos NO está
    // o incluye 'NOTE' explícitamente.
    const showOrphanNotes =
      !filters.ticketTypes ||
      filters.ticketTypes.length === 0 ||
      filters.ticketTypes.includes('NOTE');
    if (showOrphanNotes) {
      for (const note of orphanNotes) {
        tickets.push(mapNoteToTicket(note));
      }
    }

    // Summary: ventas activas (SALE, !is_deleted) + ajustes por notas.
    const activeSales = invoiceRows.filter((r) => r.ticket_type === 'SALE' && !r.is_deleted);
    const salesForRevenue = invoiceRows.filter(
      (r) => r.ticket_type === 'SALE' && (!r.is_deleted || notesByInvoice.has(Number(r.id))),
    );

    let summaryRevenue = zeroBig();
    let summaryCost = zeroBig();
    for (const inv of salesForRevenue) {
      summaryRevenue = summaryRevenue.plus(toBig(inv.original_total));
      summaryCost = summaryCost.plus(toBig(inv.original_cost));
    }
    for (const note of noteRows) {
      if (!invoiceIds.has(Number(note.sale_invoice_id))) {
        continue;
      }
      if (note.note_type === 'CREDIT') {
        summaryRevenue = summaryRevenue.minus(toBig(note.total));
        summaryCost = summaryCost.minus(toBig(note.note_cost));
      } else {
        summaryRevenue = summaryRevenue.plus(toBig(note.total));
        summaryCost = summaryCost.plus(toBig(note.note_cost));
      }
    }

    const totalRevenue = round2(summaryRevenue.toNumber());
    const totalCost = round2(summaryCost.toNumber());
    const totalProfit = calcProfit(totalRevenue, totalCost);
    const averageMargin = calcMargin(totalRevenue, totalCost);

    const summary = {
      total_sales_count: activeSales.length,
      total_notes_count: noteRows.length,
      total_orders_count: invoiceRows.filter((r) => r.ticket_type === 'ORDER' && !r.is_deleted)
        .length,
      total_voided_count: invoiceRows.filter((r) => r.is_deleted).length,
      total_partial_void_count: invoiceRows.filter(
        (r) => r.note_types?.includes('PARTIAL_VOID') && !r.is_deleted,
      ).length,
      total_debit_note_count: invoiceRows.filter(
        (r) => r.note_types?.includes('ADDITION') && !r.is_deleted,
      ).length,
      total_revenue: totalRevenue,
      total_cost: totalCost,
      total_profit: totalProfit,
      average_margin: averageMargin,
    };

    return { tickets, summary };
  }

  private mapInvoiceTicket(inv: InvoiceRow): Record<string, unknown> {
    // Saldo pendiente DERIVADO de los pagos vivos. Esta lista solo trae ventas
    // SIN crédito (sc.id IS NULL), por lo que el pendiente nace de reversar un
    // pago de una venta de contado: queda como VENTA (SALE) con saldo, sin pasar
    // a crédito. Solo aplica a ventas constituidas (SALE) vivas.
    const balanceDue = round2(Number(inv.original_total) - Number(inv.paid_amount));
    const isPending = inv.ticket_type === 'SALE' && !inv.is_deleted && balanceDue > 0;
    const paymentType = derivePaymentType(inv.payment_methods);
    return {
      id: Number(inv.id),
      rowType: 'INVOICE',
      ticketType: inv.ticket_type,
      ticketNumber: inv.ticket_number,
      saleNumber: inv.sale_number,
      originalTotal: Number(inv.original_total),
      consolidatedTotal: Number(inv.original_total),
      cost: Number(inv.original_cost),
      profit: Number(inv.original_profit),
      margin: Number(inv.original_margin),
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
      isCredit: inv.is_credit,
      creditBalance: round2(inv.credit_balance),
      creditStatus: inv.credit_status ?? null,
      balanceDue,
      isPending,
      paymentType,
    };
  }

  private buildInvoiceQuery(
    cid: string,
    filters: SalesReportQueryDto,
    dateFrom: Date,
    dateTo: Date,
    actor: AuthUser,
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [cid];
    const placeholder = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const conditions: string[] = [
      `si.company_id = $1`,
      // `sc.id IS NULL` significa que la factura NO es a crédito (consistente
      // con el filtro PlacePos original). El LEFT JOIN ya garantiza el
      // company_id de sc cuando existe.
      `sc.id IS NULL`,
    ];

    const fromPh = placeholder(dateFrom);
    conditions.push(`si.created_at >= ${fromPh}`);
    const toPh = placeholder(dateTo);
    conditions.push(`si.created_at <= ${toPh}`);

    if (filters.search?.trim()) {
      // MED-2 auditoría Fase 11: escapar wildcards de ILIKE (`%`, `_`, `\`)
      // para que el cliente no pueda controlar el patrón de match.
      const escaped = filters.search.trim().replace(/[\\%_]/g, '\\$&');
      const ph = placeholder(`%${escaped}%`);
      conditions.push(
        `(si.customer_name ILIKE ${ph} ESCAPE '\\' OR si.ticket_number ILIKE ${ph} ESCAPE '\\' OR si.sale_number ILIKE ${ph} ESCAPE '\\')`,
      );
    }

    if (filters.ticketTypes && filters.ticketTypes.length > 0) {
      const phs = filters.ticketTypes.map((t) => placeholder(t));
      conditions.push(`si.ticket_type::text IN (${phs.join(',')})`);
    }

    // Paridad PlacePos (`POSReportController.buildInvoiceQuery`): el empleado
    // solo ve sus propias ventas. owner/manager/superadmin ven todas.
    if (actor.type === 'employee') {
      conditions.push(`si.created_by_id = ${placeholder(String(actor.user_id))}`);
    }

    this.applyNoteFilter(conditions, params, filters, dateFrom, dateTo);

    // Pre-agregación de notas activas por invoice (P6). Reemplaza las dos
    // subqueries escalares correlacionadas (notes_count / note_types) que se
    // re-ejecutaban una vez por fila. Con el índice parcial
    // `idx_credit_notes_sale_invoice_active (company_id, sale_invoice_id)
    // INCLUDE (operation_type) WHERE is_deleted = false` esta agregación se
    // resuelve por Index-Only Scan. El LEFT JOIN preserva el shape original:
    // COUNT(*) → 0 vía COALESCE y STRING_AGG → NULL cuando la invoice no tiene
    // notas, exactamente como devolvían las subqueries.
    const sql = `
      WITH note_agg AS (
        SELECT
          cn2.sale_invoice_id,
          COUNT(*) AS notes_count,
          STRING_AGG(DISTINCT cn2.operation_type::text, ',') AS note_types
        FROM credit_notes cn2
        WHERE cn2.company_id = $1
          AND cn2.is_deleted = false
        GROUP BY cn2.sale_invoice_id
      )
      SELECT
        si.id::text AS id,
        si.ticket_type::text AS ticket_type,
        si.ticket_number,
        si.sale_number,
        si.total::float AS original_total,
        si.cost::float AS original_cost,
        si.profit::float AS original_profit,
        si.margin::float AS original_margin,
        si.customer_name,
        si.created_by,
        si.is_deleted,
        si.created_at,
        COALESCE(na.notes_count, 0) AS notes_count,
        na.note_types,
        (sc.id IS NOT NULL) AS is_credit,
        COALESCE(sc.balance, 0)::float AS credit_balance,
        sc.status::text AS credit_status,
        COALESCE((
          SELECT SUM(sp.amount - COALESCE(sp.change_amount, 0))
          FROM sale_payments sp
          WHERE sp.sale_invoice_id = si.id
            AND sp.company_id = $1
            AND sp.is_voided = false
        ), 0)::float AS paid_amount,
        (
          SELECT STRING_AGG(DISTINCT sp.payment_method::text, ',')
          FROM sale_payments sp
          WHERE sp.sale_invoice_id = si.id
            AND sp.company_id = $1
            AND sp.is_voided = false
        ) AS payment_methods
      FROM sale_invoices si
      LEFT JOIN sale_credits sc
        ON sc.sale_invoice_id = si.id
       AND sc.company_id = $1
      LEFT JOIN note_agg na
        ON na.sale_invoice_id = si.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY si.created_at DESC
    `;

    return { sql, params };
  }

  private applyNoteFilter(
    conditions: string[],
    params: unknown[],
    filters: SalesReportQueryDto,
    dateFrom: Date,
    dateTo: Date,
  ): void {
    // Cada predicate referencia credit_notes con company_id explícito.
    if (filters.noteFilter === 'ACTIVE_ONLY') {
      conditions.push(`si.is_deleted = false`);
      conditions.push(
        `NOT EXISTS (
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
        )`,
      );
    } else if (filters.noteFilter === 'VOIDED_ONLY') {
      conditions.push(`si.is_deleted = true`);
    } else if (filters.noteFilter === 'FULL_VOID') {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
            AND cn.operation_type = 'FULL_VOID'
        )`,
      );
    } else if (filters.noteFilter === 'PARTIAL_VOID') {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
            AND cn.operation_type = 'PARTIAL_VOID'
        )`,
      );
    } else if (filters.noteFilter === 'DEBIT_NOTES') {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
            AND cn.note_type = 'DEBIT'
        )`,
      );
    } else if (filters.noteFilter === 'WITH_ADJUSTMENTS') {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM credit_notes cn
          WHERE cn.sale_invoice_id = si.id
            AND cn.company_id = $1
            AND cn.is_deleted = false
        )`,
      );
    } else if (!filters.showDeleted) {
      // Default: ocultar borradas, EXCEPTO si tienen notas en el rango (P2).
      // `si.id IN (subquery)` en vez de `EXISTS` correlacionado: el planner lo
      // resuelve como hash semi-join (una sola evaluación) en lugar de
      // re-ejecutar el subplan por fila. Es equivalente porque
      // `credit_notes.sale_invoice_id` es NOT NULL (FK), así que no hay
      // semántica de NULL que cambie el resultado del IN.
      params.push(dateFrom);
      const fromIdx = params.length;
      params.push(dateTo);
      const toIdx = params.length;
      conditions.push(
        `(si.is_deleted = false OR si.id IN (
          SELECT cn.sale_invoice_id FROM credit_notes cn
          WHERE cn.company_id = $1
            AND cn.is_deleted = false
            AND cn.created_at BETWEEN $${fromIdx} AND $${toIdx}
        ))`,
      );
    }
  }

  private async fetchNoteRows(
    cid: string,
    dateFrom: Date,
    dateTo: Date,
    actor: AuthUser,
  ): Promise<NoteRow[]> {
    const params: unknown[] = [cid, dateFrom, dateTo];
    // Paridad PlacePos (`POSReportController.fetchNoteRows`): el empleado solo
    // ve las notas que él mismo creó.
    let employeeClause = '';
    if (actor.type === 'employee') {
      params.push(String(actor.user_id));
      employeeClause = `AND cn.created_by_id = $${params.length}`;
    }

    return this.dataSource.query<NoteRow[]>(
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
        ${employeeClause}
      ORDER BY cn.created_at ASC
      `,
      params,
    );
  }
}
