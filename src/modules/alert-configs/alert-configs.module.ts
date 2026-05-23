import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CreateDefaultAlertConfigsAction } from './actions/create-default-alert-configs.action';
import { FindAlertConfigByTypeAction } from './actions/find-alert-config-by-type.action';
import { FindAllAlertConfigsAction } from './actions/find-all-alert-configs.action';
import { UpsertAlertConfigAction } from './actions/upsert-alert-config.action';
import { AlertConfigsController } from './alert-configs.controller';
import { AlertConfigsService } from './alert-configs.service';
import { AlertConfig } from './entities/alert-config.entity';

/**
 * Módulo `alert-configs`. CRUD básico — los evaluators y schedulers viven
 * en Fase 11 y leerán de esta tabla.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AlertConfig])],
  controllers: [AlertConfigsController],
  providers: [
    AlertConfigsService,
    FindAllAlertConfigsAction,
    FindAlertConfigByTypeAction,
    UpsertAlertConfigAction,
    CreateDefaultAlertConfigsAction,
  ],
  exports: [AlertConfigsService, CreateDefaultAlertConfigsAction, TypeOrmModule],
})
export class AlertConfigsModule {}
