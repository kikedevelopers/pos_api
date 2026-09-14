import { Injectable } from '@nestjs/common';
import { In, IsNull, Not, type EntityManager } from 'typeorm';

import { nowBogota } from '@/common/utils/dayjs';
import { Product } from '@/modules/products/entities/product.entity';

import { CopyProductImageAction } from './actions/copy-product-image.action';
import {
  PurgeExpiredProductImagesAction,
  type PurgeResult,
} from './actions/purge-expired-product-images.action';
import { RemoveProductImageAction } from './actions/remove-product-image.action';
import { ResolveProductImageUrlsAction } from './actions/resolve-product-image-urls.action';
import {
  UploadProductImageAction,
  type UploadedProductImage,
} from './actions/upload-product-image.action';
import { isObjectOwnedByCompany } from './internal/image-object-name';
import type { UploadedImageFile } from './internal/image-file';
import { ALLOWED_IMAGE_TYPES, RECOMMENDED_IMAGE_SIZE_PX } from './internal/image-file';
import { ProductImageStorageService } from './product-image-storage.service';
import { ProductImageUrlCache } from './product-image-url.cache';

/** Lo que el front necesita saber para pintar y validar el campo de imagen. */
export interface ProductImageSettings {
  /** `false` = este servidor no tiene almacenamiento de imágenes configurado. */
  enabled: boolean;
  max_size_mb: number;
  recommended_width: number;
  recommended_height: number;
  accepted_formats: string[];
}

/**
 * Facade del módulo de imágenes. Sin lógica: solo delega en las actions (regla
 * §3.1 del proyecto). Es lo que consumen `ProductsController` y las actions de
 * productos que necesitan tocar imágenes.
 */
@Injectable()
export class ProductImagesService {
  constructor(
    private readonly storage: ProductImageStorageService,
    private readonly cache: ProductImageUrlCache,
    private readonly uploadAction: UploadProductImageAction,
    private readonly removeAction: RemoveProductImageAction,
    private readonly resolveUrlsAction: ResolveProductImageUrlsAction,
    private readonly copyAction: CopyProductImageAction,
    private readonly purgeAction: PurgeExpiredProductImagesAction,
  ) {}

  get isConfigured(): boolean {
    return this.storage.isConfigured;
  }

  /** Límites reales del servidor. El front los muestra y valida con ellos. */
  getSettings(): ProductImageSettings {
    return {
      enabled: this.storage.isConfigured,
      max_size_mb: Number((this.storage.maxSizeBytes / (1024 * 1024)).toFixed(2)),
      recommended_width: RECOMMENDED_IMAGE_SIZE_PX,
      recommended_height: RECOMMENDED_IMAGE_SIZE_PX,
      accepted_formats: Object.values(ALLOWED_IMAGE_TYPES),
    };
  }

  upload(params: {
    productId: number;
    companyId: number;
    file: UploadedImageFile | undefined;
    actor: { id: number; fullName: string };
  }): Promise<UploadedProductImage> {
    return this.uploadAction.execute(params);
  }

  remove(params: {
    productId: number;
    companyId: number;
    actor: { id: number; fullName: string };
  }): Promise<{ product_id: number; removed: boolean }> {
    return this.removeAction.execute(params);
  }

  resolveUrls(
    objectNames: (string | null | undefined)[],
    companyId: number,
  ): Promise<Map<string, string>> {
    return this.resolveUrlsAction.execute(objectNames, companyId);
  }

  copyTo(params: {
    sourceImage: string | null;
    targetProductId: number;
    targetCompanyId: number;
  }): Promise<string | null> {
    return this.copyAction.execute(params);
  }

  copyManyTo(
    items: { sourceImage: string | null; targetProductId: number }[],
    targetCompanyId: number,
  ): Promise<number> {
    return this.copyAction.executeMany(items, targetCompanyId);
  }

  purgeExpired(): Promise<PurgeResult> {
    return this.purgeAction.execute();
  }

  /**
   * Borra del bucket una lista concreta de imágenes cuyos productos ya no
   * existen (borrado duro de filas). Solo toca las que pertenecen a la company
   * indicada, igual que el resto de borrados. Nunca lanza.
   */
  async removeImages(objectNames: string[], companyId: number): Promise<number> {
    if (objectNames.length === 0 || !this.storage.isConfigured) {
      return 0;
    }
    let removed = 0;
    for (const objectName of objectNames) {
      if (!isObjectOwnedByCompany(objectName, this.storage.prefix, companyId)) {
        continue;
      }
      this.cache.invalidate(objectName);
      if (await this.storage.remove(objectName)) {
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Borra TODAS las imágenes de una company del bucket y las saca del caché.
   *
   * Para los borrados DUROS (eliminar un tenant, vaciar su inventario): ahí las
   * filas desaparecen y con ellas la única referencia a los archivos, así que si
   * no se limpian aquí se quedan en el bucket para siempre. Llamarla SIEMPRE
   * después de confirmar la transacción: si el borrado en BD se revierte, los
   * archivos ya no estarían.
   */
  async removeAllForCompany(companyId: number): Promise<void> {
    if (!this.storage.isConfigured) {
      return;
    }
    this.cache.invalidateByPrefix(this.storage.companyPrefix(companyId));
    await this.storage.removeCompanyFolder(companyId);
  }

  /**
   * Programa la purga de las imágenes de los productos que se acaban de
   * archivar. Se llama DENTRO de la transacción del archivado: la marca y el
   * archivado son el mismo hecho y no pueden quedar desparejos.
   *
   * No borra nada — solo apunta la fecha. El cron diario ejecuta lo vencido.
   */
  async markArchivedForPurge(
    manager: EntityManager,
    companyId: number,
    productIds: number[],
  ): Promise<void> {
    if (productIds.length === 0) {
      return;
    }

    const purgeAt = nowBogota().add(this.storage.retentionDaysAfterArchive, 'day').toDate();
    // Solo las filas CON imagen: marcar las demás llenaría el índice parcial de
    // filas que el cron nunca tendría nada que purgar.
    await manager.update(
      Product,
      {
        id: In(productIds.map(String)),
        company_id: String(companyId),
        image: Not(IsNull()),
      },
      { image_purge_at: purgeAt },
    );
  }
}
