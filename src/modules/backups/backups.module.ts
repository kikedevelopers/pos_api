import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { SuperadminSignatureGuard } from '@/modules/superadmin/guards/superadmin-signature.guard';

import { CreateBackupAction } from './actions/create-backup.action';
import { ManageBackupAction } from './actions/manage-backup.action';
import { BackupsScheduler } from './backups.scheduler';
import { BackupsController } from './backups.controller';
import { GcsStorageService } from './gcs-storage.service';

/**
 * Módulo `backups`: respaldos completos de la base de datos hacia Google Cloud
 * Storage, para el panel kdevs-admin. Sus rutas cuelgan de `/superadmin/backups`
 * (ver el controller).
 *
 * Protegido con la MISMA firma Ed25519 que `/superadmin/*` (par dedicado del
 * panel). No depende del módulo superadmin: solo reutiliza su guard, que se
 * provee aquí para no acoplar los módulos.
 *
 * `ScheduleModule.forRoot()` habilita el cron del respaldo diario
 * (`BackupsScheduler`), que reutiliza la misma acción que el botón del panel.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [BackupsController],
  providers: [
    SuperadminSignatureGuard,
    GcsStorageService,
    CreateBackupAction,
    ManageBackupAction,
    BackupsScheduler,
  ],
  exports: [GcsStorageService],
})
export class BackupsModule {}
