import { Module } from '@nestjs/common';

import { RolesModule } from '@/modules/roles/roles.module';

import { GetComparativeByDayReportAction } from './actions/get-comparative-by-day-report.action';
import { GetComparativeReportAction } from './actions/get-comparative-report.action';
import { GetDashboardSalesAction } from './actions/get-dashboard-sales.action';
import { GetSalesReportAction } from './actions/get-sales-report.action';
import { PosReportsController } from './pos-reports.controller';
import { PosReportsService } from './pos-reports.service';

/**
 * Módulo `pos-reports` (Fase 11.3). Read-only — SQL crudo vía DataSource.
 *
 * Importa `RolesModule` para que `GetSalesReportAction` resuelva los permisos
 * efectivos del actor (scope de ventas por `canViewAllSales`).
 */
@Module({
  imports: [RolesModule],
  controllers: [PosReportsController],
  providers: [
    PosReportsService,
    GetSalesReportAction,
    GetDashboardSalesAction,
    GetComparativeReportAction,
    GetComparativeByDayReportAction,
  ],
  exports: [PosReportsService],
})
export class PosReportsModule {}
