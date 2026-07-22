import { Injectable } from '@nestjs/common';

import {
  GetCreditsReportAction,
  type CreditsReportResult,
} from './actions/get-credits-report.action';
import {
  GetCustomersRfmAction,
  type CustomersRfmPagination,
  type CustomersRfmPaginatedResult,
  type CustomersRfmResult,
} from './actions/get-customers-rfm.action';
import {
  GetCustomersRfmDayTicketsAction,
  type CustomersRfmDayTicketsResult,
} from './actions/get-customers-rfm-day-tickets.action';
import { GetDailyClosureAction, type DailyClosureResult } from './actions/get-daily-closure.action';
import {
  GetSalesByHourAction,
  type SalesByHourResult,
} from './actions/get-sales-by-hour.action';
import {
  GetExtendedSummaryAction,
  type ExtendedSummaryResult,
} from './actions/get-extended-summary.action';
import type { CreditsReportQueryDto } from './dto/credits-report-query.dto';

export type {
  CreditsReportResult,
  CustomersRfmDayTicketsResult,
  CustomersRfmPaginatedResult,
  CustomersRfmResult,
  DailyClosureResult,
  ExtendedSummaryResult,
  SalesByHourResult,
};

/**
 * Facade del módulo `reports`. ZERO lógica — solo delega.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly dailyClosure: GetDailyClosureAction,
    private readonly extendedSummary: GetExtendedSummaryAction,
    private readonly creditsReport: GetCreditsReportAction,
    private readonly customersRfm: GetCustomersRfmAction,
    private readonly customersRfmDayTickets: GetCustomersRfmDayTicketsAction,
    private readonly salesByHour: GetSalesByHourAction,
  ) {}

  getDailyClosure(companyId: number, date?: string): Promise<DailyClosureResult> {
    return this.dailyClosure.execute(companyId, date);
  }

  getSalesByHour(companyId: number, date?: string): Promise<SalesByHourResult> {
    return this.salesByHour.execute(companyId, date);
  }

  getExtendedSummary(
    companyId: number,
    from?: string,
    to?: string,
  ): Promise<ExtendedSummaryResult> {
    return this.extendedSummary.execute(companyId, from, to);
  }

  getCreditsReport(
    companyId: number,
    filters: CreditsReportQueryDto,
  ): Promise<CreditsReportResult> {
    return this.creditsReport.execute(companyId, filters);
  }

  getCustomersRfm(
    companyId: number,
    from?: string,
    to?: string,
    pagination?: CustomersRfmPagination,
  ): Promise<CustomersRfmResult | CustomersRfmPaginatedResult> {
    if (pagination === undefined) {
      return this.customersRfm.execute(companyId, from, to);
    }
    return this.customersRfm.execute(companyId, from, to, pagination);
  }

  getCustomersRfmDayTickets(
    companyId: number,
    customerId: number,
    date: string,
  ): Promise<CustomersRfmDayTicketsResult> {
    return this.customersRfmDayTickets.execute(companyId, customerId, date);
  }
}
