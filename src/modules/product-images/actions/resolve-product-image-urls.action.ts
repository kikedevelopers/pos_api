import { Injectable, Logger } from '@nestjs/common';

import { ImageProxySigner } from '../image-proxy-signer.service';
import { isObjectOwnedByCompany } from '../internal/image-object-name';
import { ProductImageStorageService } from '../product-image-storage.service';
import { ProductImageUrlCache } from '../product-image-url.cache';

/**
 * Resuelve en LOTE las URLs de un listado (inventario o POS).
 *
 * Cada URL es una URL-proxy firmada por NOSOTROS (HMAC local, ver
 * {@link ImageProxySigner}), no una URL firmada de GCS: firmar en Google exige
 * la API `iam.signBlob`, deshabilitada en el proyecto de despliegue. Firmar en
 * local es instantáneo y NUNCA falla ni golpea la red.
 *
 * El caché se mantiene con otro propósito: dar una URL ESTABLE. Si se regenerara
 * el `exp` en cada request, el `<img src>` cambiaría en cada render y el
 * navegador re-descargaría la imagen. Cacheada por objeto, la misma URL se sirve
 * durante toda la ventana del caché y el navegador la reutiliza.
 */
@Injectable()
export class ResolveProductImageUrlsAction {
  private readonly logger = new Logger(ResolveProductImageUrlsAction.name);

  constructor(
    private readonly storage: ProductImageStorageService,
    private readonly cache: ProductImageUrlCache,
    private readonly signer: ImageProxySigner,
  ) {}

  /**
   * @param objectNames rutas crudas (se aceptan null/duplicadas: se limpian).
   * @param companyId   dueño esperado de las rutas. Firmar es DAR ACCESO al
   *   archivo, así que una ruta que no viva en la carpeta de esta company se
   *   descarta: `products.image` la escribe solo el servidor, pero un respaldo o
   *   una migración importados a mano podrían dejar apuntando una fila al objeto
   *   de otro tenant, y firmarlo sería servir la foto de otra empresa. Es el
   *   mismo cinturón que ya se usa para borrar y purgar.
   * @returns mapa ruta → URL firmada. Las rutas ajenas o que no se pudieron
   *   firmar no aparecen en el mapa.
   */
  async execute(
    objectNames: (string | null | undefined)[],
    companyId: number,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(objectNames.filter((name): name is string => !!name))];
    if (unique.length === 0 || !this.storage.isConfigured) {
      return new Map();
    }

    const owned: string[] = [];
    for (const name of unique) {
      if (isObjectOwnedByCompany(name, this.storage.prefix, companyId)) {
        owned.push(name);
      } else {
        this.logger.warn(
          `Imagen fuera de la carpeta de la company ${companyId} (${name}); no se firma.`,
        );
      }
    }
    if (owned.length === 0) {
      return new Map();
    }

    const resolved = this.cache.getMany(owned);
    const missing = owned.filter((name) => !resolved.has(name));
    if (missing.length === 0) {
      return resolved;
    }

    // Firmar es local e instantáneo: se hace en línea, sin lotes ni concurrencia.
    for (const objectName of missing) {
      const url = this.signer.buildUrl(objectName);
      this.cache.set(objectName, url);
      resolved.set(objectName, url);
    }

    this.logger.debug?.(
      `Imágenes resueltas: ${owned.length} pedidas, ${missing.length} firmadas en local.`,
    );

    return resolved;
  }
}
