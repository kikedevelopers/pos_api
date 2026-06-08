import { Injectable } from '@nestjs/common';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import {
  GetComparativeReportAction,
  type ComparativeReportResult,
} from './actions/get-comparative-report.action';
import {
  GetDashboardSalesAction,
  type DashboardSalesResult,
} from './actions/get-dashboard-sales.action';
import { GetSalesReportAction, type SalesReportResult } from './actions/get-sales-report.action';
import type { ComparativeReportQueryDto } from './dto/comparative-report-query.dto';
import type { DashboardSalesQueryDto, SalesReportQueryDto } from './dto/sales-report-query.dto';

export type { ComparativeReportResult, DashboardSalesResult, SalesReportResult };

/**
 * Facade del módulo `pos-reports`. ZERO lógica — solo delega.
 */
@Injectable()
export class PosReportsService {
  constructor(
    private readonly salesReport: GetSalesReportAction,
    private readonly dashboardSales: GetDashboardSalesAction,
    private readonly comparativeReport: GetComparativeReportAction,
  ) {}

  getSalesReport(
    companyId: number,
    filters: SalesReportQueryDto,
    actor: AuthUser,
  ): Promise<SalesReportResult> {
    return this.salesReport.execute(companyId, filters, actor);
  }

  getDashboardSales(
    companyId: number,
    filters: DashboardSalesQueryDto,
  ): Promise<DashboardSalesResult> {
    return this.dashboardSales.execute(companyId, filters);
  }

  getComparativeReport(
    companyId: number,
    query: ComparativeReportQueryDto,
  ): Promise<ComparativeReportResult> {
    return this.comparativeReport.execute(companyId, query);
  }
}
