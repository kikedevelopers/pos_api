import { Injectable } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import {
  fetchCreditPaymentsBreakdownByDay,
  fetchExpensesByDay,
  fetchNotesByDay,
  fetchSalesByDay,
  round2,
} from '../internal/aggregations';
import { parseDateRange, startOfMonthUtc, todayUtc } from '../internal/date-range';

/**
 * Output del endpoint `GET /dashboard/expense-impact`. Totales consolidados
 * que alimentan el pie chart "Impacto de gastos sobre la ganancia".
 *
 * `sales = cost + profit` por construcción (los abonos a crédito se descomponen
 * proporcionalmente en aggregations.ts).
 */
export interface ExpenseImpactResult {
  from: string;
  to: string;
  sales: number;
  profit: number;
  expenses: number;
  cost: number;
}

/**
 * `GET /dashboard/expense-impact?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 *
 * Defaults: `from = primer día del mes`, `to = hoy`.
 *
 * Multi-tenancy: heredada de los helpers (cada SELECT filtra `company_id = $1`).
 */
@Injectable()
export class GetExpenseImpactAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    companyId: number,
    fromInput?: string,
    toInput?: string,
  ): Promise<ExpenseImpactResult> {
    const today = todayUtc();
    const fromStr = fromInput ?? startOfMonthUtc(today);
    const toStr = toInput ?? today;
    const range = parseDateRange(fromStr, toStr);

    const [salesRows, notesRows, expensesRows, creditPaymentRows] = await Promise.all([
      fetchSalesByDay(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchNotesByDay(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchExpensesByDay(this.dataSource, companyId, range.dateStart, range.dateEnd),
      fetchCreditPaymentsBreakdownByDay(this.dataSource, companyId, range.dateStart, range.dateEnd),
    ]);

    let sales = new Big(0);
    let profit = new Big(0);
    let cost = new Big(0);
    let expenses = new Big(0);

    for (const row of salesRows) {
      sales = sales.plus(toBig(row.sales));
      profit = profit.plus(toBig(row.profit));
      cost = cost.plus(toBig(row.cost));
    }
    for (const row of notesRows) {
      const notesTotal = toBig(row.notes_total);
      const notesCost = toBig(row.notes_cost);
      const notesProfit = notesTotal.minus(notesCost);
      if (row.note_type === 'CREDIT') {
        sales = sales.minus(notesTotal);
        cost = cost.minus(notesCost);
        profit = profit.minus(notesProfit);
      } else {
        sales = sales.plus(notesTotal);
        cost = cost.plus(notesCost);
        profit = profit.plus(notesProfit);
      }
    }
    for (const row of expensesRows) {
      expenses = expenses.plus(toBig(row.expenses));
    }
    for (const row of creditPaymentRows) {
      sales = sales.plus(toBig(row.sales_share));
      cost = cost.plus(toBig(row.cost_share));
      profit = profit.plus(toBig(row.profit_share));
    }

    return {
      from: range.from,
      to: range.to,
      sales: round2(sales.toNumber()),
      profit: round2(profit.toNumber()),
      expenses: round2(expenses.toNumber()),
      cost: round2(cost.toNumber()),
    };
  }
}
