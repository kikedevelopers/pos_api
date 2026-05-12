import { Module } from '@nestjs/common';

import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

/**
 * Módulo `backup`.
 *
 * Solo expone 3 stubs HTTP (`/backup`, `POST /backup`, `/backup/:id/download`)
 * que devuelven 503 con `code: BACKUP_NOT_AVAILABLE_IN_CLOUD`. No registra
 * entidades, repositorios ni actions: el service tiene un único método que
 * loguea y lanza. Si en el futuro se implementa backup real (snapshot
 * gestionado / object storage), el módulo crece desde aquí siguiendo el
 * patrón §3.1 de actions.
 */
@Module({
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
