import { Injectable } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import {
  fetchCreditPaymentsBreakdownByDay,
  fetchCreditsGeneratedByDay,
  fetchExpensesByDay,
  fetchNotesByDay,
  fetchSalesByDay,
  round2,
} from '../internal/aggregations';
import { buildDateList, daysAgoUtc, parseDateRange, todayUtc } from '../internal/date-range';

/**
 * Output del endpoint `GET /dashboard/performance`. Series temporales + totales.
 *
 * Convención PlacePos: cada punto preserva la identidad `sales = cost + profit`
 * post-consolidación. Los `credits` son los créditos GENERADOS en ese día
 * (Pasivos), separados del recaudo.
 */
export interface PerformancePoint {
  date: string;
  sales: number;
  profit: number;
  expenses: number;
  credits: number;
}

export interface PerformanceTotals {
  sales: number;
  profit: number;
  expenses: number;
  credits: number;
  margin: number;
}

export interface PerformanceResult {
  from: string;
  to: string;
  series: PerformancePoint[];
  totals: PerformanceTotals;
}

/**
 * `GET /dashboard/performance?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 *
 * Espejo PlacePos: ventas, ganancia y gastos por día, con consolidación
 * proporcional de notas y abonos a créditos.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * Cada helper en `aggregations.ts` parametriza `company_id = $1` en TODAS sus
 * subqueries. La action solo recibe `companyId` y lo propaga. No hay queries
 * "globales" sin filtro de tenant.
 */
@Injectable()
export class GetPerformanceAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    companyId: number,
    fromInput?: string,
    toInput?: string,
  ): Promise<PerformanceResult> {
    const fromStr = fromInput ?? daysAgoUtc(6);
    const toStr = toInput ?? todayUtc();
    const range = parseDateRange(fromStr, toStr);

    // Paralelizamos los 5 reads — son SELECTs independientes contra la misma DB.
    const [salesRows, notesRows, expensesRows, creditPaymentRows, creditsGeneratedRows] =
      await Promise.all([
        fetchSalesByDay(this.dataSource, companyId, range.dateStart, range.dateEnd),
        fetchNotesByDay(this.dataSource, companyId, range.dateStart, range.dateEnd),
        fetchExpensesByDay(this.dataSource, companyId, range.dateStart, range.dateEnd),
        fetchCreditPaymentsBreakdownByDay(
          this.dataSource,
          companyId,
          range.dateStart,
          range.dateEnd,
        ),
        fetchCreditsGeneratedByDay(this.dataSource, companyId, range.dateStart, range.dateEnd),
      ]);

    interface Bucket {
      sales: Big;
      profit: Big;
      cost: Big;
      expenses: Big;
      credits: Big;
    }
    const byDate = new Map<string, Bucket>();
    const ensure = (date: string): Bucket => {
      const existing = byDate.get(date);
      if (existing) {
        return existing;
      }
      const fresh: Bucket = {
        sales: new Big(0),
        profit: new Big(0),
        cost: new Big(0),
        expenses: new Big(0),
        credits: new Big(0),
      };
      byDate.set(date, fresh);
      return fresh;
    };

    for (const row of salesRows) {
      const b = ensure(row.date);
      b.sales = b.sales.plus(toBig(row.sales));
      b.profit = b.profit.plus(toBig(row.profit));
      b.cost = b.cost.plus(toBig(row.cost));
    }

    for (const row of notesRows) {
      const b = ensure(row.date);
      const notesTotal = toBig(row.notes_total);
      const notesCost = toBig(row.notes_cost);
      const notesProfit = notesTotal.minus(notesCost);
      if (row.note_type === 'CREDIT') {
        b.sales = b.sales.minus(notesTotal);
        b.cost = b.cost.minus(notesCost);
        b.profit = b.profit.minus(notesProfit);
      } else {
        b.sales = b.sales.plus(notesTotal);
        b.cost = b.cost.plus(notesCost);
        b.profit = b.profit.plus(notesProfit);
      }
    }

    for (const row of expensesRows) {
      const b = ensure(row.date);
      b.expenses = b.expenses.plus(toBig(row.expenses));
    }

    for (const row of creditPaymentRows) {
      const b = ensure(row.date);
      b.sales = b.sales.plus(toBig(row.sales_share));
      b.cost = b.cost.plus(toBig(row.cost_share));
      b.profit = b.profit.plus(toBig(row.profit_share));
    }

    for (const row of creditsGeneratedRows) {
      const b = ensure(row.date);
      b.credits = b.credits.plus(toBig(row.credits));
    }

    const series: PerformancePoint[] = buildDateList(range.from, range.to).map((date) => {
      const b = byDate.get(date);
      return {
        date,
        sales: round2(b ? b.sales.toNumber() : 0),
        profit: round2(b ? b.profit.toNumber() : 0),
        expenses: round2(b ? b.expenses.toNumber() : 0),
        credits: round2(b ? b.credits.toNumber() : 0),
      };
    });

    // Totales: agregamos sobre `series` (ya redondeado) para que `totals = Σ
    // series`. PlacePos hace lo mismo; alinea los gráficos con el resumen.
    const totals = series.reduce(
      (acc, d) => {
        acc.sales = acc.sales.plus(d.sales);
        acc.profit = acc.profit.plus(d.profit);
        acc.expenses = acc.expenses.plus(d.expenses);
        acc.credits = acc.credits.plus(d.credits);
        return acc;
      },
      {
        sales: new Big(0),
        profit: new Big(0),
        expenses: new Big(0),
        credits: new Big(0),
      },
    );

    const salesTotal = round2(totals.sales.toNumber());
    const profitTotal = round2(totals.profit.toNumber());
    const margin = totals.sales.gt(0)
      ? round2(totals.profit.times(100).div(totals.sales).toNumber())
      : 0;

    return {
      from: range.from,
      to: range.to,
      series,
      totals: {
        sales: salesTotal,
        profit: profitTotal,
        expenses: round2(totals.expenses.toNumber()),
        credits: round2(totals.credits.toNumber()),
        margin,
      },
    };
  }
}
