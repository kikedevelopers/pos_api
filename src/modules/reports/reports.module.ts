import { Module } from '@nestjs/common';

import { GetCreditsReportAction } from './actions/get-credits-report.action';
import { GetCustomersRfmAction } from './actions/get-customers-rfm.action';
import { GetCustomersRfmDayTicketsAction } from './actions/get-customers-rfm-day-tickets.action';
import { GetDailyClosureAction } from './actions/get-daily-closure.action';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Módulo `reports` (Fase 11.2). Read-only — usa DataSource.query() crudo.
 * No declara entidades en TypeOrmModule.forFeature porque cada action
 * inyecta DataSource directamente.
 */
@Module({
  controllers: [ReportsController],
  providers: [
    ReportsService,
    GetDailyClosureAction,
    GetCreditsReportAction,
    GetCustomersRfmAction,
    GetCustomersRfmDayTicketsAction,
  ],
  exports: [ReportsService],
})
export class ReportsModule {}
