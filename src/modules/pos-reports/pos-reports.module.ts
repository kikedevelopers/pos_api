import { Module } from '@nestjs/common';

import { GetDashboardSalesAction } from './actions/get-dashboard-sales.action';
import { GetSalesReportAction } from './actions/get-sales-report.action';
import { PosReportsController } from './pos-reports.controller';
import { PosReportsService } from './pos-reports.service';

/**
 * Módulo `pos-reports` (Fase 11.3). Read-only — SQL crudo vía DataSource.
 */
@Module({
  controllers: [PosReportsController],
  providers: [PosReportsService, GetSalesReportAction, GetDashboardSalesAction],
  exports: [PosReportsService],
})
export class PosReportsModule {}
