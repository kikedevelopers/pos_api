import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CountUnreadAlertsAction } from './actions/count-unread-alerts.action';
import { FindAllAlertsAction } from './actions/find-all-alerts.action';
import { MarkAlertReadAction } from './actions/mark-alert-read.action';
import { MarkAllAlertsReadAction } from './actions/mark-all-alerts-read.action';
import { AppAlertsController } from './app-alerts.controller';
import { AppAlertsService } from './app-alerts.service';
import { AppAlert } from './entities/app-alert.entity';

/**
 * Módulo `app-alerts`. CRUD básico — los evaluators viven en Fase 11.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AppAlert])],
  controllers: [AppAlertsController],
  providers: [
    AppAlertsService,
    FindAllAlertsAction,
    CountUnreadAlertsAction,
    MarkAlertReadAction,
    MarkAllAlertsReadAction,
  ],
  exports: [AppAlertsService, TypeOrmModule],
})
export class AppAlertsModule {}
