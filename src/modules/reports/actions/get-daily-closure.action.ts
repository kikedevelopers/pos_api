import { Injectable } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import { parseUtcRange, todayUtcDate } from '../internal/range';

// ─── Tipos internos ───────────────────────────────────────────────────────────

interface SalesRow {
  gross_sales: number;
  gross_cost: number;
}

interface NotesRow {
  notes_total: number;
  notes_cost: number;
}

interface ConsigRow {
  consig_total: number;
  consig_cost: number;
}

interface ConsigDetalleRow {
  bank_name: string;
  amount: number;
}

interface AbonosRow {
  abonos_total: number;
}

interface AbonosProfitRow {
  abonos_profit: number;
}

interface ExpensesRow {
  expenses_total: number;
}

interface NewCreditsRow {
  new_credits_count: string | number;
  new_credits_total: number;
  pending_balance: number;
}

interface PendingCreditsRow {
  pending_count: string | number;
  total_amount: number;
  paid_amount: number;
  balance: number;
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
  creditsBreakdown: {
    newCreditsCount: number;
    newCreditsTotal: number;
    abonosCash: number;
    abonosConsignacion: number;
    abonosConsignacionDetalle: { bankName: string; amount: number }[];
    abonosTotal: number;
    pendingBalance: number;
  };
  expensesTotal: number;
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
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, dateInput?: string): Promise<DailyClosureResult> {
    const targetDate = dateInput ?? todayUtcDate();
    const range = parseUtcRange(targetDate, targetDate);
    const { dateStart, dateEnd } = range;
    const cid = String(companyId);

    const [salesData, creditNotesData, debitNotesData, consigData, expensesTotal] =
      await Promise.all([
        this.fetchCashSales(cid, dateStart, dateEnd),
        this.fetchCashNotes(cid, 'CREDIT', dateStart, dateEnd),
        this.fetchCashNotes(cid, 'DEBIT', dateStart, dateEnd),
        this.fetchTransferSales(cid, dateStart, dateEnd),
        this.fetchExpensesTotal(cid, dateStart, dateEnd),
      ]);

    const grossSales = salesData.gross_sales;
    const grossCost = salesData.gross_cost;
    const creditNotes = creditNotesData.notes_total;
    const creditNotesCost = creditNotesData.notes_cost;
    const debitNotes = debitNotesData.notes_total;
    const debitNotesCost = debitNotesData.notes_cost;

    const netSales = round2(
      toBig(grossSales).minus(toBig(creditNotes)).plus(toBig(debitNotes)).toNumber(),
    );
    const netCost = round2(
      toBig(grossCost).minus(toBig(creditNotesCost)).plus(toBig(debitNotesCost)).toNumber(),
    );
    const netProfit = round2(toBig(netSales).minus(toBig(netCost)).toNumber());

    const consignacionesVentas = consigData.totals.consig_total;
    const consignacionesCost = consigData.totals.consig_cost;
    const consignacionesProfit = round2(
      toBig(consignacionesVentas).minus(toBig(consignacionesCost)).toNumber(),
    );
    const consignacionesDetalle = consigData.detalle.map((r) => ({
      bankName: r.bank_name,
      amount: round2(r.amount),
    }));

    const [abonosCashData, abonosConsigData, abonosConsigDetalleRows, abonosProfit] =
      await Promise.all([
        this.fetchAbonos(cid, 'CASH', dateStart, dateEnd),
        this.fetchAbonos(cid, 'TRANSFER', dateStart, dateEnd),
        this.fetchAbonosConsigDetalle(cid, dateStart, dateEnd),
        this.fetchAbonosProfit(cid, dateStart, dateEnd),
      ]);

    const abonosCash = abonosCashData.abonos_total;
    const abonosConsig = abonosConsigData.abonos_total;
    const abonosTotal = round2(toBig(abonosCash).plus(toBig(abonosConsig)).toNumber());
    const abonosConsigDetalle = abonosConsigDetalleRows.map((r) => ({
      bankName: r.bank_name,
      amount: round2(r.amount),
    }));

    const finalTotal = round2(
      toBig(netSales)
        .plus(toBig(consignacionesVentas))
        .plus(toBig(abonosCash))
        .plus(toBig(abonosConsig))
        .minus(toBig(expensesTotal))
        .toNumber(),
    );

    const [newCreditsData, totalPendingData, adjustmentNotesRows] = await Promise.all([
      this.fetchNewCredits(cid, dateStart, dateEnd),
      this.fetchTotalPendingCredits(cid),
      this.fetchAdjustmentNotes(cid, dateStart, dateEnd),
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

    const salesProfitTotal = round2(toBig(netProfit).plus(toBig(consignacionesProfit)).toNumber());
    const salesRevenueTotal = round2(toBig(netSales).plus(toBig(consignacionesVentas)).toNumber());
    const salesMarginValue =
      salesRevenueTotal > 0
        ? round2(toBig(salesProfitTotal).div(salesRevenueTotal).times(100).toNumber())
        : 0;

    const creditsProfitTotal = round2(abonosProfit);
    const creditsMarginValue =
      abonosTotal > 0
        ? round2(toBig(creditsProfitTotal).div(abonosTotal).times(100).toNumber())
        : 0;

    const totalProfit = round2(
      toBig(netProfit).plus(toBig(consignacionesProfit)).plus(toBig(abonosProfit)).toNumber(),
    );
    const totalRevenue = round2(
      toBig(netSales).plus(toBig(consignacionesVentas)).plus(toBig(abonosTotal)).toNumber(),
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
      creditsBreakdown: {
        newCreditsCount: Number(newCreditsData.new_credits_count),
        newCreditsTotal: round2(newCreditsData.new_credits_total),
        abonosCash: round2(abonosCash),
        abonosConsignacion: round2(abonosConsig),
        abonosConsignacionDetalle: abonosConsigDetalle,
        abonosTotal,
        pendingBalance: round2(newCreditsData.pending_balance),
      },
      expensesTotal: round2(expensesTotal),
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

  private async fetchCashSales(cid: string, dateStart: Date, dateEnd: Date): Promise<SalesRow> {
    const rows = await this.dataSource.query<SalesRow[]>(
      `
      SELECT
        COALESCE(SUM(LEAST(sp.amount, si.total)), 0)::float AS gross_sales,
        COALESCE(SUM(si.cost), 0)::float AS gross_cost
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON sp.sale_invoice_id = si.id
       AND si.company_id = $1
      WHERE sp.company_id = $1
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
        AND sp.payment_method = 'CASH'
        AND si.created_at BETWEEN $2 AND $3
        AND NOT EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = si.id
            AND sc.company_id = $1
        )
      `,
      [cid, dateStart, dateEnd],
    );
    return rows[0] ?? { gross_sales: 0, gross_cost: 0 };
  }

  private async fetchCashNotes(
    cid: string,
    noteType: 'CREDIT' | 'DEBIT',
    dateStart: Date,
    dateEnd: Date,
  ): Promise<NotesRow> {
    const rows = await this.dataSource.query<NotesRow[]>(
      `
      SELECT
        COALESCE(SUM(cn.total), 0)::float AS notes_total,
        COALESCE(SUM(cnl.unit_cost * cnl.quantity), 0)::float AS notes_cost
      FROM credit_notes cn
      INNER JOIN sale_invoices si
        ON cn.sale_invoice_id = si.id
       AND si.company_id = $1
      INNER JOIN sale_payments sp
        ON sp.sale_invoice_id = si.id
       AND sp.company_id = $1
      LEFT JOIN credit_note_lines cnl
        ON cnl.credit_note_id = cn.id
       AND cnl.company_id = $1
      WHERE cn.company_id = $1
        AND cn.is_deleted = false
        AND cn.note_type = $2::note_type
        AND sp.payment_method = 'CASH'
        AND si.is_deleted = false
        AND si.created_at BETWEEN $3 AND $4
        AND NOT EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = si.id
            AND sc.company_id = $1
        )
      `,
      [cid, noteType, dateStart, dateEnd],
    );
    return rows[0] ?? { notes_total: 0, notes_cost: 0 };
  }

  private async fetchTransferSales(
    cid: string,
    dateStart: Date,
    dateEnd: Date,
  ): Promise<{ totals: ConsigRow; detalle: ConsigDetalleRow[] }> {
    const totals = await this.dataSource.query<ConsigRow[]>(
      `
      SELECT
        COALESCE(SUM(LEAST(sp.amount, si.total)), 0)::float AS consig_total,
        COALESCE(SUM(si.cost), 0)::float AS consig_cost
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON sp.sale_invoice_id = si.id
       AND si.company_id = $1
      WHERE sp.company_id = $1
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
        AND sp.payment_method = 'TRANSFER'
        AND si.created_at BETWEEN $2 AND $3
        AND NOT EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = si.id
            AND sc.company_id = $1
        )
      `,
      [cid, dateStart, dateEnd],
    );

    const detalle = await this.dataSource.query<ConsigDetalleRow[]>(
      `
      SELECT
        COALESCE(sp.bank_name, 'Sin especificar') AS bank_name,
        COALESCE(SUM(LEAST(sp.amount, si.total)), 0)::float AS amount
      FROM sale_payments sp
      INNER JOIN sale_invoices si
        ON sp.sale_invoice_id = si.id
       AND si.company_id = $1
      WHERE sp.company_id = $1
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
        AND sp.payment_method = 'TRANSFER'
        AND si.created_at BETWEEN $2 AND $3
        AND NOT EXISTS (
          SELECT 1 FROM sale_credits sc
          WHERE sc.sale_invoice_id = si.id
            AND sc.company_id = $1
        )
      GROUP BY sp.bank_name
      ORDER BY amount DESC
      `,
      [cid, dateStart, dateEnd],
    );

    return { totals: totals[0] ?? { consig_total: 0, consig_cost: 0 }, detalle };
  }

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

  private async fetchAbonosProfit(cid: string, dateStart: Date, dateEnd: Date): Promise<number> {
    const rows = await this.dataSource.query<AbonosProfitRow[]>(
      `
      WITH today_by_invoice AS (
        SELECT sp.sale_invoice_id AS invoice_id, SUM(sp.amount) AS paid_today
        FROM sale_payments sp
        WHERE sp.company_id = $1
          AND sp.created_at BETWEEN $2 AND $3
          AND EXISTS (
            SELECT 1 FROM sale_credits sc
            WHERE sc.sale_invoice_id = sp.sale_invoice_id
              AND sc.company_id = $1
          )
        GROUP BY sp.sale_invoice_id
      ),
      prior_by_invoice AS (
        SELECT sp.sale_invoice_id AS invoice_id, COALESCE(SUM(sp.amount), 0) AS paid_before
        FROM sale_payments sp
        WHERE sp.company_id = $1
          AND sp.created_at < $2
          AND EXISTS (
            SELECT 1 FROM sale_credits sc
            WHERE sc.sale_invoice_id = sp.sale_invoice_id
              AND sc.company_id = $1
          )
        GROUP BY sp.sale_invoice_id
      )
      SELECT COALESCE(SUM(
        CASE
          WHEN t.paid_today > GREATEST(0.0, si.cost - COALESCE(p.paid_before, 0.0))
          THEN t.paid_today - GREATEST(0.0, si.cost - COALESCE(p.paid_before, 0.0))
          ELSE 0.0
        END
      ), 0)::float AS abonos_profit
      FROM today_by_invoice t
      INNER JOIN sale_invoices si
        ON si.id = t.invoice_id
       AND si.company_id = $1
      LEFT JOIN prior_by_invoice p ON p.invoice_id = t.invoice_id
      `,
      [cid, dateStart, dateEnd],
    );
    return Number(rows[0]?.abonos_profit ?? 0);
  }

  private async fetchExpensesTotal(cid: string, dateStart: Date, dateEnd: Date): Promise<number> {
    const rows = await this.dataSource.query<ExpensesRow[]>(
      `
      SELECT COALESCE(SUM(amount), 0)::float AS expenses_total
      FROM expenses
      WHERE company_id = $1
        AND created_at BETWEEN $2 AND $3
        AND is_archived = false
      `,
      [cid, dateStart, dateEnd],
    );
    return Number(rows[0]?.expenses_total ?? 0);
  }

  private async fetchNewCredits(
    cid: string,
    dateStart: Date,
    dateEnd: Date,
  ): Promise<NewCreditsRow> {
    const rows = await this.dataSource.query<NewCreditsRow[]>(
      `
      SELECT
        COUNT(*) AS new_credits_count,
        COALESCE(SUM(sc.total_amount), 0)::float AS new_credits_total,
        COALESCE(SUM(sc.balance), 0)::float AS pending_balance
      FROM sale_credits sc
      INNER JOIN sale_invoices si
        ON si.id = sc.sale_invoice_id
       AND si.company_id = $1
      WHERE sc.company_id = $1
        AND si.created_at BETWEEN $2 AND $3
        AND si.ticket_type = 'SALE'
        AND si.is_deleted = false
      `,
      [cid, dateStart, dateEnd],
    );
    return (
      rows[0] ?? {
        new_credits_count: 0,
        new_credits_total: 0,
        pending_balance: 0,
      }
    );
  }

  private async fetchTotalPendingCredits(cid: string): Promise<PendingCreditsRow> {
    const rows = await this.dataSource.query<PendingCreditsRow[]>(
      `
      SELECT
        COUNT(*) AS pending_count,
        COALESCE(SUM(total_amount), 0)::float AS total_amount,
        COALESCE(SUM(paid_amount), 0)::float AS paid_amount,
        COALESCE(SUM(balance), 0)::float AS balance
      FROM sale_credits
      WHERE company_id = $1
        AND status != 'PAID'
      `,
      [cid],
    );
    return (
      rows[0] ?? {
        pending_count: 0,
        total_amount: 0,
        paid_amount: 0,
        balance: 0,
      }
    );
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
        TO_CHAR(si.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS original_invoice_date,
        COALESCE(si.customer_name, 'CONSUMIDOR FINAL') AS customer_name
      FROM credit_notes cn
      INNER JOIN sale_invoices si
        ON cn.sale_invoice_id = si.id
       AND si.company_id = $1
      WHERE cn.company_id = $1
        AND cn.is_deleted = false
        AND cn.created_at BETWEEN $2 AND $3
        AND DATE(si.created_at AT TIME ZONE 'UTC') != DATE(cn.created_at AT TIME ZONE 'UTC')
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
