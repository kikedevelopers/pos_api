import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import { isObjectOwnedByCompany } from '../internal/image-object-name';
import { ProductImageStorageService } from '../product-image-storage.service';
import { ProductImageUrlCache } from '../product-image-url.cache';

/**
 * `POST /inventory/:id/image/remove` — Quita la imagen de un item.
 *
 * Aquí sí se borra de inmediato del bucket (a diferencia de archivar, que da 7
 * días): quitar la imagen es un acto deliberado sobre un producto que sigue
 * vivo, no un efecto colateral.
 *
 * Idempotente: quitar la imagen de un producto que no tiene devuelve
 * `{ removed: false }` sin error. El cliente puede reintentar sin miedo.
 *
 * Se despunta primero la fila y después se borra el archivo: si el borrado en
 * GCS falla, el producto ya quedó sin imagen (que es lo que el usuario pidió) y
 * lo único que queda es un huérfano en el bucket.
 */
@Injectable()
export class RemoveProductImageAction {
  private readonly logger = new Logger(RemoveProductImageAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: ProductImageStorageService,
    private readonly cache: ProductImageUrlCache,
  ) {}

  async execute(params: {
    productId: number;
    companyId: number;
    actor: { id: number; fullName: string };
  }): Promise<{ product_id: number; removed: boolean }> {
    const { productId, companyId, actor } = params;

    const product = await this.dataSource.getRepository(Product).findOne({
      where: { id: String(productId), company_id: String(companyId) },
      select: { id: true, image: true },
    });
    if (!product) {
      throw new NotFoundException('Producto no encontrado.');
    }
    if (!product.image) {
      return { product_id: productId, removed: false };
    }

    const objectName = product.image;

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        Product,
        { id: String(productId), company_id: String(companyId) },
        {
          image: null,
          image_purge_at: null,
          updated_by: actor.fullName,
          updated_by_id: String(actor.id),
        },
      );
    });

    this.cache.invalidate(objectName);
    if (isObjectOwnedByCompany(objectName, this.storage.prefix, companyId)) {
      await this.storage.remove(objectName);
    } else {
      this.logger.warn(
        `Imagen de producto ${productId} fuera de su carpeta (${objectName}); se desliga sin borrar.`,
      );
    }

    this.logger.log({ event: 'product_image.removed', companyId, productId, objectName });

    return { product_id: productId, removed: true };
  }
}
