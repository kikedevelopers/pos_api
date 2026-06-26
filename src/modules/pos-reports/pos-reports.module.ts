import { Module } from '@nestjs/common';

import { GetComparativeByDayReportAction } from './actions/get-comparative-by-day-report.action';
import { GetComparativeReportAction } from './actions/get-comparative-report.action';
import { GetDashboardSalesAction } from './actions/get-dashboard-sales.action';
import { GetSalesReportAction } from './actions/get-sales-report.action';
import { PosReportsController } from './pos-reports.controller';
import { PosReportsService } from './pos-reports.service';

/**
 * Módulo `pos-reports` (Fase 11.3). Read-only — SQL crudo vía DataSource.
 */
@Module({
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
