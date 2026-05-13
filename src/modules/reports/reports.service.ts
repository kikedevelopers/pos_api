import { Injectable } from '@nestjs/common';

import {
  GetCreditsReportAction,
  type CreditsReportResult,
} from './actions/get-credits-report.action';
import { GetDailyClosureAction, type DailyClosureResult } from './actions/get-daily-closure.action';
import type { CreditsReportQueryDto } from './dto/credits-report-query.dto';

export type { CreditsReportResult, DailyClosureResult };

/**
 * Facade del módulo `reports`. ZERO lógica — solo delega.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly dailyClosure: GetDailyClosureAction,
    private readonly creditsReport: GetCreditsReportAction,
  ) {}

  getDailyClosure(companyId: number, date?: string): Promise<DailyClosureResult> {
    return this.dailyClosure.execute(companyId, date);
  }

  getCreditsReport(
    companyId: number,
    filters: CreditsReportQueryDto,
  ): Promise<CreditsReportResult> {
    return this.creditsReport.execute(companyId, filters);
  }
}
