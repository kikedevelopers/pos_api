import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import { buildImageObjectName, isObjectOwnedByCompany } from '../internal/image-object-name';
import { validateImageFile, type UploadedImageFile } from '../internal/image-file';
import { ProductImageStorageService } from '../product-image-storage.service';
import { ProductImageUrlCache } from '../product-image-url.cache';

/** Lo que se le devuelve al cliente tras subir. */
export interface UploadedProductImage {
  product_id: number;
  image: string;
  image_url: string;
}

/**
 * `POST /inventory/:id/image` — Sube (o reemplaza) la imagen de un item del
 * inventario. Sirve igual para producto base, presentación y combo: los tres
 * son filas de `products`.
 *
 * ORDEN de las operaciones, que aquí importa:
 *
 *   1. Se valida el producto y el archivo (antes de gastar una llamada a GCS).
 *   2. Se sube el objeto NUEVO, en una ruta nueva.
 *   3. Se apunta la fila al objeto nuevo.
 *   4. Recién entonces se borra el ANTERIOR.
 *
 * Si algo falla en el paso 2 o 3, el producto conserva su imagen vieja intacta.
 * El orden inverso (borrar primero) dejaría al producto sin ninguna imagen ante
 * el primer fallo de red. El precio de este orden es que un fallo en el paso 4
 * deja un archivo huérfano en el bucket; es basura barata frente a perder la
 * imagen que el usuario acaba de ver desaparecer.
 *
 * La imagen anterior NUNCA persiste: es requisito explícito del negocio y evita
 * que el bucket crezca sin techo.
 */
@Injectable()
export class UploadProductImageAction {
  private readonly logger = new Logger(UploadProductImageAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: ProductImageStorageService,
    private readonly cache: ProductImageUrlCache,
  ) {}

  async execute(params: {
    productId: number;
    companyId: number;
    file: UploadedImageFile | undefined;
    actor: { id: number; fullName: string };
  }): Promise<UploadedProductImage> {
    const { productId, companyId, file, actor } = params;

    const product = await this.dataSource.getRepository(Product).findOne({
      where: { id: String(productId), company_id: String(companyId) },
      select: { id: true, name: true, image: true, is_archived: true },
    });
    if (!product) {
      throw new NotFoundException('Producto no encontrado.');
    }
    // Un producto archivado tiene la imagen en cuenta regresiva para borrarse:
    // subir una nueva ahí sería tirarla a la basura en 7 días sin que nadie la
    // vea. Se pide restaurarlo primero.
    if (product.is_archived) {
      throw new UnprocessableEntityException({
        message: 'No se puede cambiar la imagen de un producto archivado.',
        payload: { code: 'PRODUCT_ARCHIVED' },
      });
    }

    const image = validateImageFile(file, this.storage.maxSizeBytes);

    const previousObject = product.image;
    const objectName = buildImageObjectName({
      prefix: this.storage.prefix,
      companyId,
      productId,
      extension: image.extension,
    });

    await this.storage.upload({
      objectName,
      buffer: image.buffer,
      contentType: image.mime,
      metadata: {
        companyId: String(companyId),
        productId: String(productId),
        uploadedBy: actor.fullName,
        uploadedById: String(actor.id),
      },
    });

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        Product,
        { id: String(productId), company_id: String(companyId) },
        {
          image: objectName,
          // Cambiar la imagen cancela cualquier purga pendiente: el archivo al
          // que apuntaba esa cuenta regresiva ya no es el de esta fila.
          image_purge_at: null,
          updated_by: actor.fullName,
          updated_by_id: String(actor.id),
        },
      );
    });

    if (previousObject && previousObject !== objectName) {
      this.cache.invalidate(previousObject);
      if (isObjectOwnedByCompany(previousObject, this.storage.prefix, companyId)) {
        await this.storage.remove(previousObject);
      } else {
        // Ruta que no pertenece a esta company: no se toca. Solo puede venir de
        // un dump importado a mano; borrarla arriesgaría el archivo de otro.
        this.logger.warn(
          `Imagen anterior de producto ${productId} fuera de su carpeta (${previousObject}); no se borra.`,
        );
      }
    }

    const url = await this.storage.getSignedUrl(objectName);
    this.cache.set(objectName, url);

    this.logger.log({
      event: 'product_image.uploaded',
      companyId,
      productId,
      objectName,
      sizeBytes: image.sizeBytes,
      mime: image.mime,
      replaced: previousObject !== null,
    });

    return { product_id: productId, image: objectName, image_url: url };
  }
}
