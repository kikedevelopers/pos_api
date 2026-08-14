import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { toBig } from '@/common/utils/precision';
import { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import { parseUtcRange } from '@/modules/reports/internal/range';
import { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';

import type { SalesReportQueryDto } from '../dto/sales-report-query.dto';
import {
  calcMargin,
  calcProfit,
  groupNotes,
  mapNoteToTicket,
  round2,
  salesDateFieldExpr,
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
  // COALESCE(sold_at, created_at): cuándo se REALIZÓ la venta. En un pedido
  // cobrado días después no coincide con created_at. Paridad placepos.
  sold_at: Date;
  // Ajuste por notas ya agregado (NC resta, ND suma). Viene de la vista.
  note_adjustment: number;
  note_cost_adjustment: number;
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
  if (methods.length === 0) {
    return 'UNDEFINED';
  }
  if (methods.length > 1) {
    return 'MIXED';
  }
  const only = methods[0];
  if (only === 'CASH' || only === 'TRANSFER' || only === 'CREDIT') {
    return only;
  }
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
    // Refleja el flag `include_orders_in_reports` de la company. Cuando es
    // true, `total_revenue` incluye los pedidos ORDER (no borrados). El front
    // lo propaga para replicar la inclusión en la agrupación por mes.
    include_orders_in_reports: boolean;
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
  constructor(
    private readonly dataSource: DataSource,
    private readonly resolvePermissions: ResolveEffectivePermissionsAction,
    private readonly getIncludeOrdersInReports: GetIncludeOrdersInReportsAction,
  ) {}

  /**
   * Id de usuario al que SCOPEAR las ventas, o `null` si el actor puede verlas
   * TODAS. Un actor ve todas si sus permisos efectivos incluyen `canViewAllSales`
   * (owner/superadmin lo tienen siempre; los empleados solo vía su rol — p. ej.
   * Cajero sí, Vendedor no). Reemplaza el antiguo gate por `type === 'employee'`,
   * que daba el mismo trato a todos los empleados sin importar su rol.
   */
  private async resolveScopeUserId(actor: AuthUser): Promise<string | null> {
    const effective = await this.resolvePermissions.execute({
      type: actor.type,
      account: actor.account,
      user_id: actor.user_id,
      company_id: actor.company_id,
    });
    return effective.includes('canViewAllSales') ? null : String(actor.user_id);
  }

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

    // Scope de ventas según permiso `canViewAllSales` (null = ve todas).
    const scopeToUserId = await this.resolveScopeUserId(actor);

    // Flag por company: cuando ON, los pedidos ORDER (no borrados) se cuentan
    // como INGRESO en el summary (sin tocar caja ni ganancia cobrada canónica).
    const { enabled: includeOrders } = await this.getIncludeOrdersInReports.execute(companyId);

    const { sql, params } = this.buildInvoiceQuery(cid, filters, dateFrom, dateTo, scopeToUserId);
    const invoiceRows = await this.dataSource.query<InvoiceRow[]>(sql, params);

    const invoiceIds = new Set<number>(invoiceRows.map((r) => Number(r.id)));
    const noteRows = await this.fetchNoteRows(cid, dateFrom, dateTo, scopeToUserId);
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
    // o incluye 'NOTE' explícitamente. Con filtro de categoría activo NO se
    // muestran: su ticket padre no contiene la categoría buscada.
    const showOrphanNotes =
      (!filters.ticketTypes ||
        filters.ticketTypes.length === 0 ||
        filters.ticketTypes.includes('NOTE')) &&
      (!filters.categoryIds || filters.categoryIds.length === 0);
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
    // Flag ON: el pedido ORDER vivo se asume COMPLETO, como si fuera una venta
    // normal: suma su total a los INGRESOS y su costo al COSTO, de modo que la
    // ganancia (ingresos − costo) y el margen reflejen la ganancia REAL del
    // pedido y no su total. Paridad exacta con PlacePos (`selectRevenueInvoices`).
    // Los ORDER no tienen notas crédito/débito. Esto NO afecta la ganancia
    // cobrada canónica (base caja), que se calcula aparte.
    if (includeOrders) {
      for (const inv of invoiceRows) {
        if (inv.ticket_type === 'ORDER' && !inv.is_deleted) {
          summaryRevenue = summaryRevenue.plus(toBig(inv.original_total));
          summaryCost = summaryCost.plus(toBig(inv.original_cost));
        }
      }
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

    // Conteo de notas COHERENTE con lo que se muestra: cuando las huérfanas se
    // ocultan (filtro por categoría / por tipo sin 'NOTE') solo contamos las
    // notas adjuntas a facturas visibles; si se muestran, todas. Espejo placepos.
    const visibleNotesCount = showOrphanNotes
      ? noteRows.length
      : noteRows.filter((n) => invoiceIds.has(Number(n.sale_invoice_id))).length;

    const summary = {
      total_sales_count: activeSales.length,
      total_notes_count: visibleNotesCount,
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
      include_orders_in_reports: includeOrders,
    };

    return { tickets, summary };
  }

  private mapInvoiceTicket(inv: InvoiceRow): Record<string, unknown> {
    // Saldo pendiente. Para una venta a crédito es el `sc.balance` autoritativo
    // (exacto al centavo). Para una venta de contado se deriva de los pagos
    // vivos: el pendiente nace de reversar un pago (queda como VENTA con saldo,
    // sin pasar a crédito). Solo aplica a ventas constituidas (SALE) vivas.
    const balanceDue = inv.is_credit
      ? round2(Number(inv.credit_balance))
      : round2(Number(inv.original_total) - Number(inv.paid_amount));
    const isPending = inv.ticket_type === 'SALE' && !inv.is_deleted && balanceDue > 0;
    // Una venta a crédito se rotula "Crédito" en Tipo de pago aunque aún no tenga
    // pagos (medio de pago sin definir): la distinción la da `is_credit`, no el
    // medio con que luego se abone.
    const paymentType = inv.is_credit ? 'CREDIT' : derivePaymentType(inv.payment_methods);

    // Consolidado de la fila. El margen se recalcula sobre el total ya neteado:
    // arrastrar el margen previo a las notas dejaría un porcentaje que no
    // corresponde a las cifras impresas a su lado.
    const consolidatedTotal = round2(
      toBig(inv.original_total).plus(toBig(inv.note_adjustment)).toNumber(),
    );
    const consolidatedCost = round2(
      toBig(inv.original_cost).plus(toBig(inv.note_cost_adjustment)).toNumber(),
    );
    const consolidatedProfit = round2(toBig(consolidatedTotal).minus(consolidatedCost).toNumber());
    const consolidated = {
      total: consolidatedTotal,
      cost: consolidatedCost,
      profit: consolidatedProfit,
      margin:
        consolidatedTotal > 0
          ? round2(toBig(consolidatedProfit).div(consolidatedTotal).times(100).toNumber())
          : 0,
    };
    return {
      id: Number(inv.id),
      rowType: 'INVOICE',
      ticketType: inv.ticket_type,
      ticketNumber: inv.ticket_number,
      saleNumber: inv.sale_number,
      originalTotal: Number(inv.original_total),
      // La fila lleva el CONSOLIDADO: la venta con sus notas ya aplicadas.
      // "Una venta de 200.000 a la que se le quitan 50.000 ahora se entiende
      // por 150.000". Las notas se siguen listando debajo como detalle, pero
      // aportan 0 a la suma (ver `mapNoteToTicket`): su valor ya está aquí, y
      // contarlas otra vez descuadraría la columna contra el total.
      consolidatedTotal: consolidated.total,
      cost: consolidated.cost,
      profit: consolidated.profit,
      margin: consolidated.margin,
      customerName: inv.customer_name ?? 'CONSUMIDOR FINAL',
      createdBy: inv.created_by ?? null,
      synced: true,
      isDeleted: inv.is_deleted,
      notesCount: Number(inv.notes_count),
      noteTypes: inv.note_types,
      createdAt: toIsoStr(inv.created_at),
      // Fecha de la venta propiamente dicha. El extracto mensual agrupa por
      // esta, no por la de registro. Paridad placepos.
      soldAt: toIsoStr(inv.sold_at ?? inv.created_at),
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
    scopeToUserId: string | null,
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [cid];
    const placeholder = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const conditions: string[] = [
      // Las ventas a crédito SÍ entran al reporte: una venta a crédito es una
      // venta más (se cuenta y suma a ingresos/ganancia/margen por su valor
      // íntegro el día en que se hizo). El LEFT JOIN a sale_credits solo aporta
      // el flag `is_credit`, el saldo y el estado para distinguirlas en la UI.
      `si.company_id = $1`,
    ];

    const dateExpr = salesDateFieldExpr(filters.dateField);
    const fromPh = placeholder(dateFrom);
    conditions.push(`${dateExpr} >= ${fromPh}`);
    const toPh = placeholder(dateTo);
    conditions.push(`${dateExpr} <= ${toPh}`);

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

    // Filtro por categoría (espejo placepos): el ticket pasa si tiene AL MENOS
    // UNA línea cuyo producto pertenece a alguna de las categorías. EXISTS evita
    // duplicar filas (semi-join) y conserva el SELECT/JOINs. Multi-tenant:
    // sil.company_id y p.company_id = $1.
    if (filters.categoryIds && filters.categoryIds.length > 0) {
      const phs = filters.categoryIds.map((id) => placeholder(id));
      conditions.push(
        `EXISTS (
          SELECT 1 FROM sale_invoice_lines sil
          JOIN products p ON p.id = sil.product_id AND p.company_id = $1
          WHERE sil.sale_invoice_id = si.id
            AND sil.company_id = $1
            AND p.category_id IN (${phs.join(',')})
        )`,
      );
    }

    // Scope por `canViewAllSales`: si el actor NO puede ver todas las ventas
    // (Vendedor, empleado legacy), solo ve las suyas. null = ve todas
    // (owner/superadmin/Cajero). Paridad PlacePos (`POSReportController`).
    if (scopeToUserId !== null) {
      conditions.push(`si.created_by_id = ${placeholder(scopeToUserId)}`);
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
        COALESCE(si.sold_at, si.created_at) AS sold_at,
        -- Ajuste de las notas, agregado por la vista consolidada: NC resta, ND
        -- suma. Es lo que convierte la fila en el CONSOLIDADO de la venta.
        COALESCE(adj.total_adjustment, 0)::float AS note_adjustment,
        COALESCE(adj.cost_adjustment, 0)::float AS note_cost_adjustment,
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
      LEFT JOIN "v_sale_note_adjustments" adj
        ON adj.sale_invoice_id = si.id
       AND adj.company_id = si.company_id
      LEFT JOIN sale_credits sc
        ON sc.sale_invoice_id = si.id
       AND sc.company_id = $1
      LEFT JOIN note_agg na
        ON na.sale_invoice_id = si.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${dateExpr} DESC
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
    scopeToUserId: string | null,
  ): Promise<NoteRow[]> {
    const params: unknown[] = [cid, dateFrom, dateTo];
    // Scope por `canViewAllSales`: si el actor solo ve sus ventas, también solo
    // ve las notas que él mismo creó. null = ve todas. Paridad PlacePos.
    let employeeClause = '';
    if (scopeToUserId !== null) {
      params.push(scopeToUserId);
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
        COALESCE(si.sold_at, si.created_at) AS parent_sold_at,
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
