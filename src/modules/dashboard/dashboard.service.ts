import { Injectable } from '@nestjs/common';

import {
  GetBreakEvenProgressAction,
  type BreakEvenProgressResult,
} from './actions/get-break-even-progress.action';
import {
  GetExpenseImpactAction,
  type ExpenseImpactResult,
} from './actions/get-expense-impact.action';
import { GetPerformanceAction, type PerformanceResult } from './actions/get-performance.action';
import { GetTodayAction, type TodayResult } from './actions/get-today.action';
import {
  GetTodayByCashierAction,
  type TodayByCashierResult,
} from './actions/get-today-by-cashier.action';
import { GetTopProductsAction, type TopProductItem } from './actions/get-top-products.action';

export type {
  BreakEvenProgressResult,
  ExpenseImpactResult,
  PerformanceResult,
  TodayByCashierResult,
  TodayResult,
  TopProductItem,
};

/**
 * Facade del módulo `dashboard`. ZERO lógica de negocio — solo delega a las
 * actions. Paridad de patrón con `SalesService` y `CreditsService`.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly getPerformance: GetPerformanceAction,
    private readonly getToday: GetTodayAction,
    private readonly getExpenseImpact: GetExpenseImpactAction,
    private readonly getTopProducts: GetTopProductsAction,
    private readonly getBreakEvenProgress: GetBreakEvenProgressAction,
    private readonly getTodayByCashier: GetTodayByCashierAction,
  ) {}

  performance(companyId: number, from?: string, to?: string): Promise<PerformanceResult> {
    return this.getPerformance.execute(companyId, from, to);
  }

  today(companyId: number, date?: string): Promise<TodayResult> {
    return this.getToday.execute(companyId, date);
  }

  expenseImpact(companyId: number, from?: string, to?: string): Promise<ExpenseImpactResult> {
    return this.getExpenseImpact.execute(companyId, from, to);
  }

  topProducts(companyId: number, limit?: number): Promise<TopProductItem[]> {
    return this.getTopProducts.execute(companyId, limit);
  }

  breakEvenProgress(companyId: number, date?: string): Promise<BreakEvenProgressResult> {
    return this.getBreakEvenProgress.execute(companyId, date);
  }

  todayByCashier(companyId: number, date?: string): Promise<TodayByCashierResult> {
    return this.getTodayByCashier.execute(companyId, date);
  }
}
