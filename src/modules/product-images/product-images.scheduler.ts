import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { APP_TIMEZONE } from '@/common/utils/dayjs';

import { PurgeExpiredProductImagesAction } from './actions/purge-expired-product-images.action';
import { ProductImageStorageService } from './product-image-storage.service';

/**
 * 03:00 de cada día, hora de Colombia. De madrugada y lejos de la medianoche
 * (donde ya corre el respaldo de la BD) para no competir por la misma ventana.
 */
export const PURGE_IMAGES_CRON = '0 3 * * *';

/**
 * Limpieza diaria de las imágenes de productos archivados que ya cumplieron su
 * retención.
 *
 * Solo decide CUÁNDO; el qué lo hace `PurgeExpiredProductImagesAction`, que es
 * el mismo camino que se puede invocar a mano. Nunca lanza: un fallo aquí se
 * registra y se reintenta al día siguiente — la basura en el bucket puede
 * esperar, tumbar el proceso no.
 *
 * Con más de una instancia del API cada una correría su propio cron y las
 * purgas se pisarían; el borrado es idempotente (`ignoreNotFound`), así que el
 * peor caso es un log de advertencia. Con un solo contenedor —el despliegue
 * actual— no aplica.
 */
@Injectable()
export class ProductImagesScheduler {
  private readonly logger = new Logger(ProductImagesScheduler.name);
  /** Evita que dos corridas se pisen si una tarda más de lo previsto. */
  private running = false;

  constructor(
    private readonly storage: ProductImageStorageService,
    private readonly purgeAction: PurgeExpiredProductImagesAction,
  ) {}

  @Cron(PURGE_IMAGES_CRON, { name: 'purge-product-images', timeZone: APP_TIMEZONE })
  async handleDailyPurge(): Promise<void> {
    await this.run('programada');
  }

  async run(trigger: string): Promise<void> {
    if (!this.storage.isConfigured) {
      return;
    }
    if (this.running) {
      this.logger.warn(`Purga de imágenes ${trigger} omitida: la anterior sigue en curso.`);
      return;
    }

    this.running = true;
    try {
      const result = await this.purgeAction.execute();
      if (result.purged > 0) {
        this.logger.log(
          `Purga de imágenes ${trigger}: ${result.purged} borrada(s), ${result.failed} fallida(s).`,
        );
      }
    } catch (e) {
      this.logger.error(`Purga de imágenes ${trigger} FALLIDA: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
