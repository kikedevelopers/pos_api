import { Module } from '@nestjs/common';

import { MigrationImportModule } from '@/modules/migration-import/migration-import.module';

import { RestoreBackupAction } from './actions/restore-backup.action';
import { BackupRestoreController } from './backup-restore.controller';

/**
 * Módulo de restauración de backup NATIVO de placepos para el OWNER
 * autenticado (`POST /backup/restore`).
 *
 * Reutiliza la maquinaria del import admin importando `MigrationImportModule`,
 * que exporta `ImportZipAction` (provee `importModulesIntoCompany`). Así no se
 * re-registran las entities ni los `CreateDefault*Action` de seed: viven en
 * `MigrationImportModule`. El `DataSource` lo provee TypeORM globalmente.
 *
 * No genera ciclo: `MigrationImportModule` no importa este módulo.
 */
@Module({
  imports: [MigrationImportModule],
  controllers: [BackupRestoreController],
  providers: [RestoreBackupAction],
})
export class BackupRestoreModule {}
