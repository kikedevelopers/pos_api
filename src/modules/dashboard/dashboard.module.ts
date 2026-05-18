import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

import { GetBreakEvenProgressAction } from './actions/get-break-even-progress.action';
import { GetExpenseImpactAction } from './actions/get-expense-impact.action';
import { GetPerformanceAction } from './actions/get-performance.action';
import { GetTodayAction } from './actions/get-today.action';
import { GetTodayByCashierAction } from './actions/get-today-by-cashier.action';
import { GetTopProductsAction } from './actions/get-top-products.action';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * Módulo `dashboard` (Fase 11.1). Read-only sobre `sale_invoices`,
 * `sale_payments`, `sale_credits`, `credit_notes`, `credit_note_lines`,
 * `sale_invoice_lines`, `expenses` y `companies`. Casi todo se hace via SQL
 * crudo (DataSource.query) — los repos solo intervienen para `Company`
 * porque se lee con TypeORM convencional.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Company])],
  controllers: [DashboardController],
  providers: [
    DashboardService,
    GetPerformanceAction,
    GetTodayAction,
    GetExpenseImpactAction,
    GetTopProductsAction,
    GetBreakEvenProgressAction,
    GetTodayByCashierAction,
  ],
  exports: [DashboardService],
})
export class DashboardModule {}
