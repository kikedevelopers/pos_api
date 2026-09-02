import { Injectable, Logger } from '@nestjs/common';

import { isObjectOwnedByCompany } from '../internal/image-object-name';
import { ProductImageStorageService } from '../product-image-storage.service';
import { ProductImageUrlCache } from '../product-image-url.cache';

/**
 * Cuántas firmas se piden a la vez cuando el caché no las tiene.
 *
 * Importa sobre todo en la carga EN FRÍO: el caché nace vacío en cada
 * despliegue y en cada reinicio del contenedor, así que la primera apertura de
 * la app después de un release firma el catálogo entero dentro del request. Con
 * ADC —como corre producción— cada firma es una llamada a `iam.signBlob`, y con
 * lotes de 8 un catálogo de 500 fotos serían ~63 vueltas de red en serie.
 *
 * 24 baja eso a ~21 sin volverse agresivo con la cuota: firmar es una operación
 * liviana, muy lejos de lo que pesa subir o descargar un objeto.
 */
const SIGN_CONCURRENCY = 24;

/**
 * Resuelve en LOTE las URLs firmadas de un listado (inventario o POS).
 *
 * Es el punto donde el caché hace su trabajo: un catálogo de 500 productos con
 * foto se resuelve con 500 lecturas de memoria y CERO llamadas a Google
 * mientras las entradas sigan vivas. Solo se firma lo que falta, y con
 * concurrencia acotada para no abrir 500 conexiones de golpe.
 *
 * Nunca lanza: si una firma falla, ese producto viaja con `image_url: null` y
 * el front muestra el placeholder. Un bucket caído no puede tumbar el listado
 * del inventario ni dejar al POS sin vender.
 */
@Injectable()
export class ResolveProductImageUrlsAction {
  private readonly logger = new Logger(ResolveProductImageUrlsAction.name);

  constructor(
    private readonly storage: ProductImageStorageService,
    private readonly cache: ProductImageUrlCache,
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

    let failures = 0;
    for (let i = 0; i < missing.length; i += SIGN_CONCURRENCY) {
      const batch = missing.slice(i, i + SIGN_CONCURRENCY);
      const urls = await Promise.all(
        batch.map(async (objectName) => {
          try {
            return await this.storage.getSignedUrl(objectName);
          } catch (e) {
            failures += 1;
            this.logger.warn(`No se pudo firmar ${objectName}: ${(e as Error).message}`);
            return null;
          }
        }),
      );
      batch.forEach((objectName, index) => {
        const url = urls[index];
        if (url) {
          this.cache.set(objectName, url);
          resolved.set(objectName, url);
        }
      });
    }

    this.logger.debug?.(
      `Imágenes resueltas: ${owned.length} pedidas, ${missing.length} firmadas, ${failures} fallidas.`,
    );

    return resolved;
  }
}
