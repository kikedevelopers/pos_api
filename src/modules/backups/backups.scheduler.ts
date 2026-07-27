import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { APP_TIMEZONE } from '@/common/utils/dayjs';
import type { BackupsConfig } from '@/config/backups.config';

import { CreateBackupAction } from './actions/create-backup.action';
import { GcsStorageService } from './gcs-storage.service';

/** Medianoche de cada día, en hora de Colombia. */
export const DAILY_BACKUP_CRON = '0 0 * * *';

/**
 * Respaldo automático diario.
 *
 * Ejecuta EXACTAMENTE lo mismo que el botón del panel (`CreateBackupAction`):
 * mismo nombrado, misma retención de 7 y las mismas verificaciones. Aquí solo
 * se decide *cuándo* y se traduce el fallo a un log en vez de a un 500.
 *
 * Ojo si algún día se levanta más de una instancia de la API: cada una correría
 * su propio cron. Con un solo contenedor —el despliegue actual— no aplica.
 */
@Injectable()
export class BackupsScheduler {
  private readonly logger = new Logger(BackupsScheduler.name);
  private readonly config: BackupsConfig;
  /** Evita que dos ejecuciones se pisen si una tarda más de lo previsto. */
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly storage: GcsStorageService,
    private readonly createBackupAction: CreateBackupAction,
  ) {
    this.config = this.configService.getOrThrow<BackupsConfig>('backups');
  }

  @Cron(DAILY_BACKUP_CRON, { name: 'daily-backup', timeZone: APP_TIMEZONE })
  async handleDailyBackup(): Promise<void> {
    await this.run('programado');
  }

  /**
   * Lanza el respaldo. Nunca lanza excepción: un fallo aquí no debe tumbar el
   * proceso ni dejar el scheduler bloqueado.
   */
  async run(trigger: string): Promise<void> {
    if (!this.config.cronEnabled) {
      this.logger.log(`Respaldo ${trigger} omitido: BACKUP_CRON_ENABLED=false.`);
      return;
    }
    if (!this.storage.isConfigured) {
      this.logger.warn(`Respaldo ${trigger} omitido: falta GCS_BACKUP_BUCKET.`);
      return;
    }
    if (this.running) {
      this.logger.warn(`Respaldo ${trigger} omitido: el anterior sigue en curso.`);
      return;
    }

    this.running = true;
    try {
      const result = await this.createBackupAction.execute();
      this.logger.log(
        `Respaldo ${trigger} completado: ${result.fileName} ` +
          `(${result.sizeBytes} bytes, ${result.durationMs} ms, ${result.prunedCount} podado(s)).`,
      );
    } catch (e) {
      this.logger.error(`Respaldo ${trigger} FALLIDO: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
