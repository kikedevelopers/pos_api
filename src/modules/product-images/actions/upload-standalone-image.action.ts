import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { ImageProxySigner } from '../image-proxy-signer.service';
import { isObjectOwnedByCompany } from '../internal/image-object-name';
import { validateImageFile, type UploadedImageFile } from '../internal/image-file';
import { ProductImageStorageService } from '../product-image-storage.service';
import { ProductImageUrlCache } from '../product-image-url.cache';

/** Resultado de subir una imagen suelta (no atada a un producto). */
export interface UploadedStandaloneImage {
  /** Ruta del objeto en el bucket (lo que guarda la fila dueña). */
  object: string;
  /** URL-proxy firmada (relativa) lista para `<img src>`. */
  url: string;
}

/**
 * Sube una imagen que NO pertenece a un producto (p. ej. la portada del
 * catálogo). Reutiliza el mismo almacenamiento, validación por magic-bytes,
 * carpeta por company y proxy firmado que las imágenes de inventario — así la
 * portada vive en `inventory_items/<company_id>/` y el proxy público la sirve y
 * el borrado por tenant la limpia sin tratarla distinto.
 *
 * No toca la BD: devuelve la ruta y la URL; la fila dueña (la company) la
 * persiste quien llama. Reemplazo seguro: sube el objeto NUEVO primero y, solo
 * si se indicó, borra el ANTERIOR (nunca deja a la fila sin imagen ante un fallo).
 */
@Injectable()
export class UploadStandaloneImageAction {
  private readonly logger = new Logger(UploadStandaloneImageAction.name);

  constructor(
    private readonly storage: ProductImageStorageService,
    private readonly cache: ProductImageUrlCache,
    private readonly signer: ImageProxySigner,
  ) {}

  async execute(params: {
    companyId: number;
    file: UploadedImageFile | undefined;
    /** Prefijo legible del nombre del objeto, p. ej. `catalog-cover`. */
    keyHint: string;
    /** Ruta anterior a borrar tras subir la nueva (si la había). */
    previousObject?: string | null;
    /** Tope de peso propio (p. ej. portada). Por defecto el de producto. */
    maxSizeBytes?: number;
    actor: { id: number; fullName: string };
  }): Promise<UploadedStandaloneImage> {
    const { companyId, file, keyHint, previousObject, maxSizeBytes, actor } = params;

    const image = validateImageFile(file, maxSizeBytes ?? this.storage.maxSizeBytes);

    const folder = this.storage.prefix.replace(/^\/+|\/+$/g, '');
    const suffix = randomBytes(8).toString('hex');
    const objectName = `${folder}/${companyId}/${keyHint}-${suffix}.${image.extension}`;

    await this.storage.upload({
      objectName,
      buffer: image.buffer,
      contentType: image.mime,
      metadata: {
        companyId: String(companyId),
        kind: keyHint,
        uploadedBy: actor.fullName,
        uploadedById: String(actor.id),
      },
    });

    if (
      previousObject &&
      previousObject !== objectName &&
      isObjectOwnedByCompany(previousObject, this.storage.prefix, companyId)
    ) {
      this.cache.invalidate(previousObject);
      await this.storage.remove(previousObject);
    }

    const url = this.signer.buildUrl(objectName);
    this.cache.set(objectName, url);

    this.logger.log({
      event: 'standalone_image.uploaded',
      companyId,
      kind: keyHint,
      objectName,
      sizeBytes: image.sizeBytes,
      mime: image.mime,
      replaced: Boolean(previousObject),
    });

    return { object: objectName, url };
  }
}
