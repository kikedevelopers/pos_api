import { Injectable } from '@nestjs/common';

import { FindAlertConfigByTypeAction } from './actions/find-alert-config-by-type.action';
import { FindAllAlertConfigsAction } from './actions/find-all-alert-configs.action';
import { UpsertAlertConfigAction } from './actions/upsert-alert-config.action';
import type { UpsertAlertConfigDto } from './dto/upsert-alert-config.dto';
import type { AlertConfig } from './entities/alert-config.entity';

/**
 * Facade delgado del módulo `alert-configs`. ZERO lógica — delega a actions.
 */
@Injectable()
export class AlertConfigsService {
  constructor(
    private readonly findAllAction: FindAllAlertConfigsAction,
    private readonly findByTypeAction: FindAlertConfigByTypeAction,
    private readonly upsertAction: UpsertAlertConfigAction,
  ) {}

  findAll(companyId: number): Promise<AlertConfig[]> {
    return this.findAllAction.execute(companyId);
  }

  findByType(type: string, companyId: number): Promise<AlertConfig> {
    return this.findByTypeAction.execute(type, companyId);
  }

  upsert(type: string, dto: UpsertAlertConfigDto, companyId: number): Promise<AlertConfig> {
    return this.upsertAction.execute(type, dto, companyId);
  }
}
