import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import NodeCache from 'node-cache';

import type { ProductImagesConfig } from '@/config/product-images.config';

/**
 * TTL efectivo del caché, acotado a la mitad de la vigencia de la URL firmada.
 *
 * Una URL se guarda al firmarla y se puede entregar hasta el último segundo
 * antes de que el caché la expulse. Si el caché durara lo mismo que la firma,
 * ese último cliente recibiría un enlace a punto de vencer y vería la imagen
 * rota. Con la mitad, la URL entregada siempre conserva al menos otro tanto de
 * vida por delante.
 */
export function resolveCacheTtlSeconds(cacheTtl: number, signedUrlTtl: number): number {
  const safeCeiling = Math.floor(signedUrlTtl / 2);
  return Math.max(1, Math.min(cacheTtl, safeCeiling));
}

/**
 * Caché en memoria de las URLs firmadas de las imágenes del inventario.
 *
 * Por qué existe: firmar una URL con credenciales de la máquina (ADC, que es
 * como corre producción) NO es una operación local — Google la resuelve con una
 * llamada a `iam.signBlob`, que tiene cuota. Sin caché, cada listado del
 * inventario o del POS dispararía una firma por producto y agotaríamos la cuota
 * en cuestión de minutos.
 *
 * La clave es la RUTA DEL OBJETO, no el id del producto: la ruta cambia con
 * cada imagen nueva (lleva sufijo aleatorio), así que una entrada obsoleta
 * jamás puede devolver la URL de una imagen que ya no existe. Aun así se
 * invalida explícitamente al reemplazar, quitar o purgar, para no quedarnos con
 * URLs de objetos ya borrados ocupando memoria.
 *
 * Es un caché POR INSTANCIA (no compartido). Con el despliegue actual —un solo
 * contenedor— alcanza; si algún día hay varias réplicas, cada una mantendrá el
 * suyo y el único costo es firmar una vez por réplica.
 */
@Injectable()
export class ProductImageUrlCache {
  private readonly logger = new Logger(ProductImageUrlCache.name);
  private readonly cache: NodeCache;
  readonly ttlSeconds: number;

  constructor(configService: ConfigService) {
    const config = configService.getOrThrow<ProductImagesConfig>('productImages');
    this.ttlSeconds = resolveCacheTtlSeconds(config.cacheTtlSeconds, config.signedUrlTtlSeconds);

    this.cache = new NodeCache({
      stdTTL: this.ttlSeconds,
      // Las URLs son strings inmutables: clonarlas en cada lectura solo gasta
      // memoria y CPU.
      useClones: false,
      // Purga perezosa cada 10 min. El listado del inventario pide cientos de
      // claves de golpe; barrer más seguido no aporta nada.
      checkperiod: 600,
    });

    if (this.ttlSeconds < config.cacheTtlSeconds) {
      this.logger.warn(
        `PRODUCT_IMAGE_CACHE_TTL_S (${config.cacheTtlSeconds}s) recortado a ${this.ttlSeconds}s ` +
          `para no superar la mitad de PRODUCT_IMAGE_SIGNED_URL_TTL_S (${config.signedUrlTtlSeconds}s).`,
      );
    }
  }

  get(objectName: string): string | undefined {
    return this.cache.get<string>(objectName);
  }

  /** Lee varias rutas de golpe (lo que hace un listado). */
  getMany(objectNames: string[]): Map<string, string> {
    const hits = this.cache.mget<string>(objectNames);
    return new Map(Object.entries(hits));
  }

  set(objectName: string, url: string): void {
    this.cache.set(objectName, url);
  }

  /** Invalida una ruta. Se llama al reemplazar, quitar o purgar la imagen. */
  invalidate(objectName: string | null | undefined): void {
    if (!objectName) {
      return;
    }
    this.cache.del(objectName);
  }

  invalidateMany(objectNames: (string | null | undefined)[]): void {
    const names = objectNames.filter((name): name is string => !!name);
    if (names.length > 0) {
      this.cache.del(names);
    }
  }

  /**
   * Invalida todo lo que cuelgue de un prefijo (la carpeta de una company).
   *
   * La usan los borrados duros: si los archivos desaparecen del bucket pero sus
   * URLs siguen en el caché, el listado seguiría entregando enlaces a objetos
   * que ya no existen hasta que expiraran solos.
   */
  invalidateByPrefix(prefix: string): number {
    const matching = this.cache.keys().filter((key) => key.startsWith(prefix));
    if (matching.length > 0) {
      this.cache.del(matching);
    }
    return matching.length;
  }

  /** Solo para tests y diagnóstico. */
  clear(): void {
    this.cache.flushAll();
  }

  get size(): number {
    return this.cache.keys().length;
  }
}
