import { Injectable } from '@nestjs/common';

import {
  GetDashboardSalesAction,
  type DashboardSalesResult,
} from './actions/get-dashboard-sales.action';
import { GetSalesReportAction, type SalesReportResult } from './actions/get-sales-report.action';
import type { DashboardSalesQueryDto, SalesReportQueryDto } from './dto/sales-report-query.dto';

export type { DashboardSalesResult, SalesReportResult };

/**
 * Facade del módulo `pos-reports`. ZERO lógica — solo delega.
 */
@Injectable()
export class PosReportsService {
  constructor(
    private readonly salesReport: GetSalesReportAction,
    private readonly dashboardSales: GetDashboardSalesAction,
  ) {}

  getSalesReport(companyId: number, filters: SalesReportQueryDto): Promise<SalesReportResult> {
    return this.salesReport.execute(companyId, filters);
  }

  getDashboardSales(
    companyId: number,
    filters: DashboardSalesQueryDto,
  ): Promise<DashboardSalesResult> {
    return this.dashboardSales.execute(companyId, filters);
  }
}
