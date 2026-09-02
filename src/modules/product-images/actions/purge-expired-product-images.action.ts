import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { nowBogota } from '@/common/utils/dayjs';
import { Product } from '@/modules/products/entities/product.entity';

import { isObjectOwnedByCompany } from '../internal/image-object-name';
import { ProductImageStorageService } from '../product-image-storage.service';
import { ProductImageUrlCache } from '../product-image-url.cache';

/** Cuántas filas se purgan por corrida. Techo defensivo, no un límite real. */
const PURGE_BATCH_SIZE = 500;

export interface PurgeResult {
  /** Filas cuya imagen se borró del bucket y se despuntó en la BD. */
  purged: number;
  /** Objetos que GCS no pudo borrar (la fila se despunta igual). */
  failed: number;
}

/**
 * Borra las imágenes de productos archivados cuya retención ya venció.
 *
 * El plazo se marca al archivar (`image_purge_at`); aquí solo se ejecuta lo que
 * ya cumplió. Si alguien restauró el producto o le cambió la imagen antes del
 * plazo, la marca se limpió y esa fila ni siquiera aparece en la consulta.
 *
 * La fila se despunta (`image = NULL`) SIEMPRE, incluso si GCS no pudo borrar el
 * objeto: dejarla apuntando a un archivo que ya se declaró basura solo
 * garantizaría reintentar el mismo borrado cada día para siempre. El huérfano se
 * registra en el log y se limpia en el bucket cuando haga falta.
 */
@Injectable()
export class PurgeExpiredProductImagesAction {
  private readonly logger = new Logger(PurgeExpiredProductImagesAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: ProductImageStorageService,
    private readonly cache: ProductImageUrlCache,
  ) {}

  async execute(): Promise<PurgeResult> {
    if (!this.storage.isConfigured) {
      return { purged: 0, failed: 0 };
    }

    const now = nowBogota().toDate();
    const expired = await this.dataSource
      .getRepository(Product)
      .createQueryBuilder('p')
      .select(['p.id', 'p.company_id', 'p.image'])
      .where('p.image IS NOT NULL')
      .andWhere('p.image_purge_at IS NOT NULL')
      .andWhere('p.image_purge_at <= :now', { now })
      .orderBy('p.image_purge_at', 'ASC')
      .limit(PURGE_BATCH_SIZE)
      .getMany();

    if (expired.length === 0) {
      return { purged: 0, failed: 0 };
    }

    let failed = 0;
    for (const product of expired) {
      const objectName = product.image;
      if (!objectName) {
        continue;
      }

      this.cache.invalidate(objectName);

      const owned = isObjectOwnedByCompany(
        objectName,
        this.storage.prefix,
        Number(product.company_id),
      );
      if (owned) {
        const removed = await this.storage.remove(objectName);
        if (!removed) {
          failed += 1;
          this.logger.warn(
            `Imagen huérfana en el bucket: ${objectName} (producto ${product.id}). Se despunta igual.`,
          );
        }
      } else {
        this.logger.warn(
          `Imagen de producto ${product.id} fuera de su carpeta (${objectName}); se despunta sin borrar.`,
        );
      }

      await this.dataSource.transaction(async (manager) => {
        await manager.update(
          Product,
          { id: product.id, company_id: product.company_id },
          { image: null, image_purge_at: null },
        );
      });
    }

    this.logger.log({
      event: 'product_image.purged',
      purged: expired.length,
      failed,
    });

    return { purged: expired.length, failed };
  }
}
