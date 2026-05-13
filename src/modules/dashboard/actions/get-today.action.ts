import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import {
  fetchExpensesTotal,
  fetchNewCredits,
  fetchPaymentsTotal,
  fetchProfitTotal,
  fetchSalesNotesAdjustment,
  round2,
} from '../internal/aggregations';
import { parseDateRange, todayUtc } from '../internal/date-range';

/**
 * Output del endpoint `GET /dashboard/today`. Resumen consolidado del día
 * (espejo PlacePos byte-por-byte).
 *
 * Convenciones:
 *   - `cashSales` / `transferSales` = pagos a ventas REGULARES (no crédito)
 *     ajustados por notas (NC resta, ND suma) del mismo día.
 *   - `creditPaymentsCash` / `creditPaymentsTransfer` = abonos recibidos a
 *     invoices a crédito (Activos del día).
 *   - `newCredits` = créditos GENERADOS (Pasivos): conteo + total.
 *   - `realProfit` = `profit - expenses`.
 *   - `surplus` = `totalCollected - profit` (excedente sobre la ganancia).
 */
export interface TodayResult {
  date: string;
  cashSales: number;
  transferSales: number;
  creditPaymentsCash: number;
  creditPaymentsTransfer: number;
  creditPaymentsTotal: number;
  totalCollected: number;
  profit: number;
  surplus: number;
  expenses: number;
  realProfit: number;
  newCredits: { count: number; total: number };
}

/**
 * `GET /dashboard/today?date=YYYY-MM-DD`.
 *
 * Multi-tenancy: cada helper en `aggregations.ts` filtra `company_id = $1`.
 */
@Injectable()
export class GetTodayAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, dateInput?: string): Promise<TodayResult> {
    const today = dateInput ?? todayUtc();
    // parseDateRange con from=to válida el formato y el límite (1 día).
    const range = parseDateRange(today, today);

    const [
      salesCash,
      salesTransfer,
      ncCash,
      ndCash,
      ncTransfer,
      ndTransfer,
      creditsCash,
      creditsTransfer,
      profitTotal,
      expensesTotal,
      newCredits,
    ] = await Promise.all([
      fetchPaymentsTotal(this.dataSource, companyId, 'CASH', false, range.dateStart, range.dateEnd),
      fetchPaymentsTotal(
        this.dataSource,
        companyId,
        'TRANSFER',
        false,
        range.dateStart,
        range.dateEnd,
      ),
      fetchSalesNotesAdjustment(
        this.dataSource,
        companyId,
        'CASH',
        'CREDIT',
        range.dateStart,
        range.dateEnd,
      ),
      fetchSalesNotesAdjustment(
        this.dataSource,
        companyId,
        'CASH',
        'DEBIT',
        range.dateStart,
        range.dateEnd,
      ),
      fetchSalesNotesAdjustment(
        this.dataSource,
        companyId,
        'TRANSFER',
        'CREDIT',
        range.dateStart,
        range.dateEnd,
      ),
      fetchSalesNotesAdjustment(
        this.dataSource,
        companyId,
        'TRANSFER',
        'DEBIT',
        range.dateStart,
        range.dateEnd,
      ),
      fetchPaymentsTotal(this.dataSource, companyId, 'CASH', true, range.dateStart, range.dateEnd),
      fetchPaymentsTotal(
        this.dataSource,
        companyId,
        'TRANSFER',
        true,
        range.dateStart,
        range.dateEnd,
      ),
      fetchProfitTotal(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchExpensesTotal(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchNewCredits(this.dataSource, companyId, range.dateStart, range.dateEnd),
    ]);

    const cashSales = round2(toBig(salesCash).minus(toBig(ncCash)).plus(toBig(ndCash)).toNumber());
    const transferSales = round2(
      toBig(salesTransfer).minus(toBig(ncTransfer)).plus(toBig(ndTransfer)).toNumber(),
    );
    const creditPaymentsCash = round2(creditsCash);
    const creditPaymentsTransfer = round2(creditsTransfer);
    const creditPaymentsTotal = round2(
      toBig(creditPaymentsCash).plus(toBig(creditPaymentsTransfer)).toNumber(),
    );

    const totalCollected = round2(
      toBig(cashSales)
        .plus(toBig(transferSales))
        .plus(toBig(creditPaymentsCash))
        .plus(toBig(creditPaymentsTransfer))
        .toNumber(),
    );

    const expenses = round2(expensesTotal);
    const profit = round2(profitTotal);
    const surplus = round2(toBig(totalCollected).minus(toBig(profit)).toNumber());
    const realProfit = round2(toBig(profit).minus(toBig(expenses)).toNumber());

    return {
      date: today,
      cashSales,
      transferSales,
      creditPaymentsCash,
      creditPaymentsTransfer,
      creditPaymentsTotal,
      totalCollected,
      profit,
      surplus,
      expenses,
      realProfit,
      newCredits: {
        count: newCredits.count,
        total: round2(newCredits.amount),
      },
    };
  }
}
