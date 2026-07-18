import { Injectable } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import {
  fetchAbonoCollectedProfit,
  fetchAbonoCollectedProfitByCreditAge,
  fetchCollectedProfit,
} from '@/modules/financial-facts/internal/collection-facts';

import { toBig } from '@/common/utils/precision';

import { parseUtcRange, todayUtcDate } from '../internal/range';
import {
  computeConsignacionesProfit,
  computeNetCashSales,
  computeOrdersProfit,
  EMPTY_ORDERS_BILLING,
  fetchCashNotes,
  fetchCashSales,
  fetchExpensesDetail,
  fetchExpensesTotal,
  fetchFixedExpensePaymentsDetail,
  fetchNewCredits,
  fetchOrdersBilling,
  fetchTotalPendingCredits,
  fetchTransferSales,
  type ConsigDetalleRow,
} from '../internal/sales-aggregations';

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface AbonosRow {
  abonos_total: number;
}

interface AdjustmentNoteRow {
  note_number: string;
  note_type: string;
  operation_type: string;
  total: number;
  original_invoice_number: string;
  original_invoice_date: string;
  customer_name: string;
}

/**
 * Grupo de recaudo de cartera (abonos) discriminado por edad del crédito. El
 * dinero entró hoy; se agrupa según si el crédito abonado nació hoy o antes.
 */
export interface AbonoAgeGroup {
  cash: number;
  consignacion: number;
  consignacionDetalle: { bankName: string; amount: number }[];
  total: number;
  profit: number;
  margin: number;
}

export interface DailyClosureResult {
  date: string;
  cashSalesTotal: number;
  salesBreakdown: {
    grossSales: number;
    creditNotes: number;
    debitNotes: number;
    netSales: number;
  };
  consignacionesVentas: number;
  consignacionesDetalle: { bankName: string; amount: number }[];
  /**
   * Facturación de pedidos (`ticket_type='ORDER'`, no borrados) del día.
   * Solo > 0 con el flag `include_orders_in_reports` ON; con OFF → 0 (y ni
   * siquiera se emite la query).
   *
   * Con el flag ON el pedido se asume COMPLETO, como si fuera una venta normal:
   * suma a `salesProfit`/`salesMargin` y a `profit`/`margin`. Lo que NUNCA toca
   * es la CAJA: `finalTotal`, `cashSalesTotal`, `consignacionesVentas` y los
   * abonos quedan idénticos (un pedido no cobrado no entra a caja).
   */
  ordersTotal: number;
  /**
   * Venta directa (contado) discriminada: total, ganancia y margen ANTES del
   * crédito (contado neto + consignaciones + pedidos). Sumada con el crédito
   * del día da `salesProfit`/`salesMargin` (el total del bloque Ventas del Día).
   */
  directSalesTotal: number;
  directSalesProfit: number;
  directSalesMargin: number;
  creditsBreakdown: {
    newCreditsCount: number;
    newCreditsTotal: number;
    // Ganancia/margen DEVENGADOS de los créditos del día (discriminados en el
    // bloque "Ventas del Día"; YA sumados en salesProfit/salesRevenue/salesMargin).
    newCreditsProfit: number;
    newCreditsMargin: number;
    abonosCash: number;
    abonosConsignacion: number;
    abonosConsignacionDetalle: { bankName: string; amount: number }[];
    abonosTotal: number;
    /**
     * Recaudo de cartera del día DISCRIMINADO por edad del crédito al que se
     * abona: `previous` = abonos a créditos de días anteriores; `today` = abonos
     * a créditos nacidos hoy. `previous + today` reconcilia con abonosCash/
     * abonosConsignacion/abonosTotal y con creditsProfit (el global no cambia).
     */
    abonosByCreditAge: {
      previous: AbonoAgeGroup;
      today: AbonoAgeGroup;
    };
    pendingBalance: number;
  };
  expensesTotal: number;
  expensesDetail: { concept: string; source: string | null; amount: number }[];
  fixedExpensePaymentsTotal: number;
  fixedExpensePayments: {
    concept: string;
    source: string | null;
    totalAmount: number;
    paidAmount: number;
    balance: number;
    dueDate: string | null;
    paidAt: string;
  }[];
  finalTotal: number;
  profit: number;
  margin: number;
  salesProfit: number;
  salesMargin: number;
  creditsProfit: number;
  creditsMargin: number;
  totalPendingCredits: {
    count: number;
    totalAmount: number;
    paidAmount: number;
    balance: number;
  };
  adjustmentNotes: Array<{
    noteNumber: string;
    noteType: string;
    operationType: string;
    total: number;
    originalInvoiceNumber: string;
    originalInvoiceDate: string;
    customerName: string;
  }>;
  adjustmentNotesSummary: {
    count: number;
    totalCredit: number;
    totalDebit: number;
  };
}

const round2 = (n: unknown): number => Number(toBig(n).round(2).toString());

/**
 * `GET /reports/daily-closure?date=YYYY-MM-DD`.
 *
 * Espejo PlacePos byte-por-byte. Cierre diario consolidando:
 *   - Ventas en efectivo netas (post NC/ND aplicadas al mismo día).
 *   - Consignaciones (transfer) detalladas por banco.
 *   - Abonos a créditos (cash y transfer).
 *   - Créditos generados hoy.
 *   - Saldo total pendiente de TODOS los créditos.
 *   - Gastos.
 *   - Notas de ajuste (aquellas cuyo invoice padre es de otro día).
 *   - Facturación de pedidos (`ordersTotal`), solo con el flag
 *     `include_orders_in_reports` ON. Ver la nota del campo en el contrato.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * TODAS las 11 queries internas filtran por `company_id = $1`. Si una rama
 * lo omitiera, una company vería datos de otra — bug CRÍTICO. El test cubre
 * este invariante.
 */
@Injectable()
export class GetDailyClosureAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly getIncludeOrdersInReports: GetIncludeOrdersInReportsAction,
  ) {}

  async execute(companyId: number, dateInput?: string): Promise<DailyClosureResult> {
    const targetDate = dateInput ?? todayUtcDate();
    const range = parseUtcRange(targetDate, targetDate);
    const { dateStart, dateEnd } = range;
    const cid = String(companyId);

    const [
      salesData,
      creditNotesData,
      debitNotesData,
      consigData,
      expensesTotal,
      expensesDetailRows,
      fixedExpensePaymentRows,
      includeOrdersConfig,
    ] = await Promise.all([
      fetchCashSales(this.dataSource, cid, dateStart, dateEnd),
      fetchCashNotes(this.dataSource, cid, 'CREDIT', dateStart, dateEnd),
      fetchCashNotes(this.dataSource, cid, 'DEBIT', dateStart, dateEnd),
      fetchTransferSales(this.dataSource, cid, dateStart, dateEnd),
      fetchExpensesTotal(this.dataSource, cid, dateStart, dateEnd),
      fetchExpensesDetail(this.dataSource, cid, dateStart, dateEnd),
      fetchFixedExpensePaymentsDetail(this.dataSource, cid, dateStart, dateEnd),
      this.getIncludeOrdersInReports.execute(companyId),
    ]);

    const expensesDetail = expensesDetailRows.map((r) => ({
      concept: r.concept,
      source: r.source,
      amount: round2(r.amount),
    }));

    const toIso = (value: Date | string | null): string | null => {
      if (value == null) {
        return null;
      }
      return value instanceof Date ? value.toISOString() : String(value);
    };

    const fixedExpensePayments = fixedExpensePaymentRows.map((r) => ({
      concept: r.concept,
      source: r.source,
      totalAmount: round2(r.total_amount),
      paidAmount: round2(r.paid_amount),
      balance: round2(r.balance),
      dueDate: toIso(r.due_date),
      paidAt: toIso(r.paid_at) ?? '',
    }));

    const fixedExpensePaymentsTotal = round2(
      fixedExpensePaymentRows
        .reduce((acc, r) => acc.plus(toBig(r.paid_amount)), new Big(0))
        .toNumber(),
    );

    const grossSales = salesData.gross_sales;
    const creditNotes = creditNotesData.notes_total;
    const debitNotes = debitNotesData.notes_total;

    const { netSales, netProfit } = computeNetCashSales(salesData, creditNotesData, debitNotesData);

    const consignacionesVentas = consigData.totals.consig_total;
    const consignacionesProfit = computeConsignacionesProfit(consigData.totals);
    const consignacionesDetalle = consigData.detalle.map((r) => ({
      bankName: r.bank_name,
      amount: round2(r.amount),
    }));

    const [
      abonosCashData,
      abonosConsigData,
      abonosConsigDetalleRows,
      abonosProfit,
      ordersData,
      abonosCashByAge,
      abonosConsigByAge,
      abonosConsigDetalleByAge,
      abonoProfitByAge,
    ] = await Promise.all([
      this.fetchAbonos(cid, 'CASH', dateStart, dateEnd),
      this.fetchAbonos(cid, 'TRANSFER', dateStart, dateEnd),
      this.fetchAbonosConsigDetalle(cid, dateStart, dateEnd),
      // Utilidad cobrada de abonos por modelo PROPORCIONAL (canónico), no
      // cascada. Ver financial-facts/contracts/metrics-spec.md.
      fetchAbonoCollectedProfit(this.dataSource, companyId, dateStart, dateEnd),
      // Facturación de pedidos: solo con el flag ON (OFF → fila neutra, sin query).
      includeOrdersConfig.enabled
        ? fetchOrdersBilling(this.dataSource, cid, dateStart, dateEnd)
        : Promise.resolve(EMPTY_ORDERS_BILLING),
      // Recaudo de cartera discriminado por edad del crédito (días anteriores vs
      // del día). Aditivo: NO altera los globales de arriba.
      this.fetchAbonosByAge(cid, 'CASH', dateStart, dateEnd),
      this.fetchAbonosByAge(cid, 'TRANSFER', dateStart, dateEnd),
      this.fetchAbonosConsigDetalleByAge(cid, dateStart, dateEnd),
      fetchAbonoCollectedProfitByCreditAge(this.dataSource, companyId, dateStart, dateEnd),
    ]);

    // Pedidos del día (0 con el flag OFF). `ordersProfit` es la ganancia REAL
    // del pedido (total - costo): con el flag ON se asume COMPLETO.
    const ordersTotal = round2(ordersData.orders_total);
    const ordersProfit = computeOrdersProfit(ordersData);

    const abonosCash = abonosCashData.abonos_total;
    const abonosConsig = abonosConsigData.abonos_total;
    const abonosTotal = round2(toBig(abonosCash).plus(toBig(abonosConsig)).toNumber());
    const abonosConsigDetalle = abonosConsigDetalleRows.map((r) => ({
      bankName: r.bank_name,
      amount: round2(r.amount),
    }));

    // Recaudo de cartera del día discriminado por edad del crédito. `total` es el
    // dinero (efectivo + consignación) y `margin` la utilidad cobrada sobre ese
    // dinero, igual criterio que el global de la card. previous+today reconcilia
    // con los globales (abonosCash/abonosConsig/abonosTotal, creditsProfit).
    const buildAbonoGroup = (which: 'previous' | 'today'): AbonoAgeGroup => {
      const cash = round2(abonosCashByAge[which]);
      const consignacion = round2(abonosConsigByAge[which]);
      const consignacionDetalle = abonosConsigDetalleByAge[which].map((r) => ({
        bankName: r.bank_name,
        amount: round2(r.amount),
      }));
      const total = round2(toBig(cash).plus(toBig(consignacion)).toNumber());
      const profit = round2(abonoProfitByAge[which]);
      const margin =
        total > 0 ? round2(toBig(profit).div(total).times(100).toNumber()) : 0;
      return { cash, consignacion, consignacionDetalle, total, profit, margin };
    };
    const abonosByCreditAge = {
      previous: buildAbonoGroup('previous'),
      today: buildAbonoGroup('today'),
    };

    const finalTotal = round2(
      toBig(netSales)
        .plus(toBig(consignacionesVentas))
        .plus(toBig(abonosCash))
        .plus(toBig(abonosConsig))
        .minus(toBig(expensesTotal))
        .toNumber(),
    );

    const [newCreditsData, totalPendingData, adjustmentNotesRows, collectedProfitValue] =
      await Promise.all([
        fetchNewCredits(this.dataSource, cid, dateStart, dateEnd),
        fetchTotalPendingCredits(this.dataSource, cid),
        this.fetchAdjustmentNotes(cid, dateStart, dateEnd),
        fetchCollectedProfit(this.dataSource, companyId, dateStart, dateEnd),
      ]);

    const adjustmentNotes = adjustmentNotesRows.map((row) => ({
      noteNumber: row.note_number,
      noteType: row.note_type,
      operationType: row.operation_type,
      total: round2(row.total),
      originalInvoiceNumber: row.original_invoice_number,
      originalInvoiceDate: row.original_invoice_date,
      customerName: row.customer_name,
    }));

    let totalCreditAdj = new Big(0);
    let totalDebitAdj = new Big(0);
    for (const r of adjustmentNotesRows) {
      if (r.note_type === 'CREDIT') {
        totalCreditAdj = totalCreditAdj.plus(toBig(r.total));
      } else {
        totalDebitAdj = totalDebitAdj.plus(toBig(r.total));
      }
    }
    const adjustmentNotesSummary = {
      count: adjustmentNotesRows.length,
      totalCredit: round2(totalCreditAdj.toNumber()),
      totalDebit: round2(totalDebitAdj.toNumber()),
    };

    // Créditos del día (DEVENGADO): una venta a crédito es una venta más, así que
    // su valor y ganancia ÍNTEGROS entran al bloque "Ventas del Día" el día en
    // que se hace, discriminados. NO se confunde con "Recaudo de Cartera"
    // (abonos), que es dinero real y va en su propio bloque.
    const newCreditsTotal = round2(newCreditsData.new_credits_total);
    const newCreditsProfit = round2(newCreditsData.new_credits_profit);
    const newCreditsMargin =
      newCreditsTotal > 0
        ? round2(toBig(newCreditsProfit).div(newCreditsTotal).times(100).toNumber())
        : 0;

    // Venta directa (contado) discriminada = contado neto + consignaciones +
    // pedidos, SIN crédito. Su propio total, ganancia y margen; sumada con el
    // crédito del día da el total del bloque (salesProfit/salesMargin).
    const directSalesTotal = round2(
      toBig(netSales).plus(toBig(consignacionesVentas)).plus(toBig(ordersTotal)).toNumber(),
    );
    const directSalesProfit = round2(
      toBig(netProfit).plus(toBig(consignacionesProfit)).plus(toBig(ordersProfit)).toNumber(),
    );
    const directSalesMargin =
      directSalesTotal > 0
        ? round2(toBig(directSalesProfit).div(directSalesTotal).times(100).toNumber())
        : 0;

    // Bloque VENTAS DEL DÍA = contado (neto NC/ND) + consignaciones + CRÉDITOS +
    // pedidos. Con el flag de pedidos ON el pedido se asume COMPLETO. Con crédito
    // 0 y pedidos 0 las cifras son idénticas a las de siempre.
    const salesProfitTotal = round2(
      toBig(netProfit)
        .plus(toBig(consignacionesProfit))
        .plus(toBig(newCreditsProfit))
        .plus(toBig(ordersProfit))
        .toNumber(),
    );
    const salesRevenueTotal = round2(
      toBig(netSales)
        .plus(toBig(consignacionesVentas))
        .plus(toBig(newCreditsTotal))
        .plus(toBig(ordersTotal))
        .toNumber(),
    );
    const salesMarginValue =
      salesRevenueTotal > 0
        ? round2(toBig(salesProfitTotal).div(salesRevenueTotal).times(100).toNumber())
        : 0;

    const creditsProfitTotal = round2(abonosProfit);
    const creditsMarginValue =
      abonosTotal > 0
        ? round2(toBig(creditsProfitTotal).div(abonosTotal).times(100).toNumber())
        : 0;

    // "Ganancia del día" (headline CAJA) = utilidad COBRADA: la porción de
    // utilidad dentro del recaudo (contado + abonos proporcionales). Fiel a la
    // caja: una venta a crédito NO suma su ganancia hasta cobrarse. Alimenta las
    // tarjetas de caja del Dashboard/Finanzas. Es DISTINTA del bloque "Ventas del
    // Día" (`salesProfit`), que ahora es DEVENGADO e incluye el crédito íntegro:
    // por diseño la venta (devengado) y el recaudo (caja) ya no coinciden. Ver
    // financial-facts/contracts/metrics-spec.md.
    //
    // Flag `include_orders_in_reports` ON: se le SUMA ARRIBA la ganancia real de
    // los pedidos del día. El delta se aplica AQUÍ, en el action del informe —
    // `fetchCollectedProfit` (métrica canónica, base caja) NO se toca. Con OFF
    // `ordersProfit`/`ordersTotal` son 0 → totalProfit ≡ collectedProfit.
    const totalProfit = round2(toBig(collectedProfitValue).plus(toBig(ordersProfit)).toNumber());
    // Margen sobre el recaudo del día (contado neto + consignación + abonos) +
    // la facturación de pedidos asumida (0 con el flag OFF).
    const totalRevenue = round2(
      toBig(netSales)
        .plus(toBig(consignacionesVentas))
        .plus(toBig(abonosTotal))
        .plus(toBig(ordersTotal))
        .toNumber(),
    );
    const totalMargin =
      totalRevenue > 0 ? round2(toBig(totalProfit).div(totalRevenue).times(100).toNumber()) : 0;

    return {
      date: targetDate,
      cashSalesTotal: round2(netSales),
      salesBreakdown: {
        grossSales: round2(grossSales),
        creditNotes: round2(creditNotes),
        debitNotes: round2(debitNotes),
        netSales: round2(netSales),
      },
      consignacionesVentas: round2(consignacionesVentas),
      consignacionesDetalle,
      ordersTotal,
      directSalesTotal,
      directSalesProfit,
      directSalesMargin,
      creditsBreakdown: {
        newCreditsCount: Number(newCreditsData.new_credits_count),
        newCreditsTotal,
        // Ganancia/margen DEVENGADOS de los créditos del día, para mostrarlos
        // discriminados dentro del bloque "Ventas del Día".
        newCreditsProfit,
        newCreditsMargin,
        abonosCash: round2(abonosCash),
        abonosConsignacion: round2(abonosConsig),
        abonosConsignacionDetalle: abonosConsigDetalle,
        abonosTotal,
        abonosByCreditAge,
        pendingBalance: round2(newCreditsData.pending_balance),
      },
      expensesTotal: round2(expensesTotal),
      expensesDetail,
      fixedExpensePaymentsTotal,
      fixedExpensePayments,
      finalTotal,
      profit: totalProfit,
      margin: totalMargin,
      salesProfit: salesProfitTotal,
      salesMargin: salesMarginValue,
      creditsProfit: creditsProfitTotal,
      creditsMargin: creditsMarginValue,
      totalPendingCredits: {
        count: Number(totalPendingData.pending_count),
        totalAmount: round2(totalPendingData.total_amount),
        paidAmount: round2(totalPendingData.paid_amount),
        balance: round2(totalPendingData.balance),
      },
      adjustmentNotes,
      adjustmentNotesSummary,
    };
  }

  // ─── Helpers privados (paridad PlacePos con company_id) ────────────────────

  private async fetchAbonos(
    cid: string,
    method: 'CASH' | 'TRANSFER',
    dateStart: Date,
    dateEnd: Date,
  ): Promise<AbonosRow> {
    const rows = await this.dataSource.query<AbonosRow[]>(
      `
      SELECT COALESCE(SUM(sp.amount), 0)::float AS abonos_total
      FROM sale_payments sp
      WHERE sp.company_id = $1
        AND sp.is_voided = false
        AND sp.created_at BETWEEN $2 AND $3
        AND sp.payment_method = $4::payment_method
        AND EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = sp.sale_invoice_id
            AND sc.company_id = $1
        )
      `,
      [cid, dateStart, dateEnd, method],
    );
    return rows[0] ?? { abonos_total: 0 };
  }

  private async fetchAbonosConsigDetalle(
    cid: string,
    dateStart: Date,
    dateEnd: Date,
  ): Promise<ConsigDetalleRow[]> {
    return this.dataSource.query<ConsigDetalleRow[]>(
      `
      SELECT
        COALESCE(sp.bank_name, 'Sin especificar') AS bank_name,
        COALESCE(SUM(sp.amount), 0)::float AS amount
      FROM sale_payments sp
      WHERE sp.company_id = $1
        AND sp.is_voided = false
        AND sp.created_at BETWEEN $2 AND $3
        AND sp.payment_method = 'TRANSFER'
        AND EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = sp.sale_invoice_id
            AND sc.company_id = $1
        )
      GROUP BY sp.bank_name
      ORDER BY amount DESC
      `,
      [cid, dateStart, dateEnd],
    );
  }

  /**
   * Recaudo de abonos (por método) discriminado por edad del crédito abonado:
   * `today` = crédito nacido hoy, `previous` = crédito de días anteriores. El
   * pago entró hoy en ambos casos (`sp.created_at`). La suma de los dos grupos
   * es EXACTAMENTE el total (misma query, particionada por `is_today`).
   */
  private async fetchAbonosByAge(
    cid: string,
    method: 'CASH' | 'TRANSFER',
    dateStart: Date,
    dateEnd: Date,
  ): Promise<{ previous: number; today: number }> {
    const rows = await this.dataSource.query<{ is_today: boolean; abonos_total: number }[]>(
      `
      SELECT
        (COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3) AS is_today,
        COALESCE(SUM(sp.amount), 0)::float AS abonos_total
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON si.id = sp.sale_invoice_id
       AND si.company_id = $1
      WHERE sp.company_id = $1
        AND sp.is_voided = false
        AND sp.created_at BETWEEN $2 AND $3
        AND sp.payment_method = $4::payment_method
        AND EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = sp.sale_invoice_id
            AND sc.company_id = $1
        )
      GROUP BY is_today
      `,
      [cid, dateStart, dateEnd, method],
    );
    const out = { previous: 0, today: 0 };
    for (const row of rows) {
      if (row.is_today) out.today = Number(row.abonos_total ?? 0);
      else out.previous = Number(row.abonos_total ?? 0);
    }
    return out;
  }

  /** Detalle de abonos por consignación (banco) discriminado por edad del crédito. */
  private async fetchAbonosConsigDetalleByAge(
    cid: string,
    dateStart: Date,
    dateEnd: Date,
  ): Promise<{ previous: ConsigDetalleRow[]; today: ConsigDetalleRow[] }> {
    const rows = await this.dataSource.query<
      { is_today: boolean; bank_name: string; amount: number }[]
    >(
      `
      SELECT
        (COALESCE(si.sold_at, si.created_at) BETWEEN $2 AND $3) AS is_today,
        COALESCE(sp.bank_name, 'Sin especificar') AS bank_name,
        COALESCE(SUM(sp.amount), 0)::float AS amount
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON si.id = sp.sale_invoice_id
       AND si.company_id = $1
      WHERE sp.company_id = $1
        AND sp.is_voided = false
        AND sp.created_at BETWEEN $2 AND $3
        AND sp.payment_method = 'TRANSFER'
        AND EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = sp.sale_invoice_id
            AND sc.company_id = $1
        )
      GROUP BY is_today, sp.bank_name
      ORDER BY amount DESC
      `,
      [cid, dateStart, dateEnd],
    );
    const out: { previous: ConsigDetalleRow[]; today: ConsigDetalleRow[] } = {
      previous: [],
      today: [],
    };
    for (const row of rows) {
      const record = { bank_name: row.bank_name, amount: row.amount };
      if (row.is_today) out.today.push(record);
      else out.previous.push(record);
    }
    return out;
  }

  private async fetchAdjustmentNotes(
    cid: string,
    dateStart: Date,
    dateEnd: Date,
  ): Promise<AdjustmentNoteRow[]> {
    return this.dataSource.query<AdjustmentNoteRow[]>(
      `
      SELECT
        cn.note_number,
        cn.note_type::text AS note_type,
        cn.operation_type::text AS operation_type,
        cn.total::float AS total,
        si.ticket_number AS original_invoice_number,
        TO_CHAR(si.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS original_invoice_date,
        COALESCE(si.customer_name, 'CONSUMIDOR FINAL') AS customer_name
      FROM credit_notes cn
      INNER JOIN sale_invoices si
        ON cn.sale_invoice_id = si.id
       AND si.company_id = $1
      WHERE cn.company_id = $1
        AND cn.is_deleted = false
        AND cn.created_at BETWEEN $2 AND $3
        AND DATE(si.created_at AT TIME ZONE 'America/Bogota') != DATE(cn.created_at AT TIME ZONE 'America/Bogota')
        AND NOT EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = si.id
            AND sc.company_id = $1
        )
      ORDER BY cn.created_at ASC
      `,
      [cid, dateStart, dateEnd],
    );
  }
}
