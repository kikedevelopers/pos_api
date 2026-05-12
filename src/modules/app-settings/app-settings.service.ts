import { Injectable } from '@nestjs/common';

import { FindAllAppSettingsAction } from './actions/find-all-app-settings.action';
import { FindAppSettingByKeyAction } from './actions/find-app-setting-by-key.action';
import { UpsertAppSettingAction } from './actions/upsert-app-setting.action';
import type { AppSetting } from './entities/app-setting.entity';

/**
 * Facade delgado del módulo `app-settings`. ZERO lógica — delega a actions.
 *
 * `CreateDefaultAppSettingsAction` NO se expone aquí: se inyecta
 * directamente en `RegisterAction` para el seed inicial.
 */
@Injectable()
export class AppSettingsService {
  constructor(
    private readonly findAllAction: FindAllAppSettingsAction,
    private readonly findByKeyAction: FindAppSettingByKeyAction,
    private readonly upsertAction: UpsertAppSettingAction,
  ) {}

  findAll(companyId: number): Promise<AppSetting[]> {
    return this.findAllAction.execute(companyId);
  }

  findByKey(key: string, companyId: number): Promise<AppSetting> {
    return this.findByKeyAction.execute(key, companyId);
  }

  upsert(key: string, value: string, companyId: number): Promise<AppSetting> {
    return this.upsertAction.execute(key, value, companyId);
  }
}
