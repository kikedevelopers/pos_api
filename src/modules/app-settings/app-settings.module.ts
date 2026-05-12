import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CreateDefaultAppSettingsAction } from './actions/create-default-app-settings.action';
import { FindAllAppSettingsAction } from './actions/find-all-app-settings.action';
import { FindAppSettingByKeyAction } from './actions/find-app-setting-by-key.action';
import { UpsertAppSettingAction } from './actions/upsert-app-setting.action';
import { AppSettingsController } from './app-settings.controller';
import { AppSettingsService } from './app-settings.service';
import { AppSetting } from './entities/app-setting.entity';

/**
 * Módulo `app-settings`. Re-exporta `CreateDefaultAppSettingsAction` para que
 * `RegisterAction` seedee las claves por defecto al crear una company.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AppSetting])],
  controllers: [AppSettingsController],
  providers: [
    AppSettingsService,
    FindAllAppSettingsAction,
    FindAppSettingByKeyAction,
    UpsertAppSettingAction,
    CreateDefaultAppSettingsAction,
  ],
  exports: [AppSettingsService, CreateDefaultAppSettingsAction, TypeOrmModule],
})
export class AppSettingsModule {}
