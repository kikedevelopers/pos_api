import { Module } from '@nestjs/common';

import { AppSettingsModule } from '@/modules/app-settings/app-settings.module';

import { GetCreditsReportAction } from './actions/get-credits-report.action';
import { GetCustomersRfmAction } from './actions/get-customers-rfm.action';
import { GetCustomersRfmDayTicketsAction } from './actions/get-customers-rfm-day-tickets.action';
import { GetDailyClosureAction } from './actions/get-daily-closure.action';
import { GetSalesByHourAction } from './actions/get-sales-by-hour.action';
import { GetExtendedSummaryAction } from './actions/get-extended-summary.action';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Módulo `reports` (Fase 11.2). Read-only — usa DataSource.query() crudo.
 * No declara entidades en TypeOrmModule.forFeature porque cada action
 * inyecta DataSource directamente.
 *
 * Importa `AppSettingsModule` para leer el flag `include_orders_in_reports`
 * (facturación de pedidos en el extended-summary) por company.
 */
@Module({
  imports: [AppSettingsModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    GetDailyClosureAction,
    GetSalesByHourAction,
    GetExtendedSummaryAction,
    GetCreditsReportAction,
    GetCustomersRfmAction,
    GetCustomersRfmDayTicketsAction,
  ],
  exports: [ReportsService],
})
export class ReportsModule {}
