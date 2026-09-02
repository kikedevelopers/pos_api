import type { ConfigService } from '@nestjs/config';

import type { ProductImagesConfig } from '@/config/product-images.config';

import { ProductImageUrlCache, resolveCacheTtlSeconds } from '../product-image-url.cache';

/**
 * El caché es la pieza que evita agotar la cuota de firma de Google: sin él,
 * cada listado del inventario o del POS firmaría una URL por producto.
 */

const CONFIG: ProductImagesConfig = {
  bucket: 'placepos-bucket-1',
  prefix: 'inventory_items',
  maxSizeBytes: 2 * 1024 * 1024,
  signedUrlTtlSeconds: 86400,
  cacheTtlSeconds: 21600,
  retentionDaysAfterArchive: 7,
};

function buildCache(overrides: Partial<ProductImagesConfig> = {}): ProductImageUrlCache {
  const config = { ...CONFIG, ...overrides };
  return new ProductImageUrlCache({ getOrThrow: () => config } as unknown as ConfigService);
}

describe('resolveCacheTtlSeconds · la URL cacheada nunca llega vencida', () => {
  it('respeta el TTL configurado cuando cabe holgado en la vigencia de la firma', () => {
    expect(resolveCacheTtlSeconds(21600, 86400)).toBe(21600);
  });

  it('recorta el TTL a la mitad de la firma cuando lo supera', () => {
    // Con caché y firma iguales, el último cliente en recibir una URL cacheada
    // se llevaría un enlace a punto de caducar.
    expect(resolveCacheTtlSeconds(86400, 86400)).toBe(43200);
  });

  it('recorta también cuando el caché dura MÁS que la firma', () => {
    expect(resolveCacheTtlSeconds(200000, 3600)).toBe(1800);
  });

  it('nunca devuelve 0 ni negativos con vigencias absurdamente cortas', () => {
    expect(resolveCacheTtlSeconds(10, 1)).toBe(1);
  });
});

describe('ProductImageUrlCache', () => {
  it('devuelve lo guardado', () => {
    const cache = buildCache();
    cache.set('inventory_items/8/1-a.jpg', 'https://signed/1');

    expect(cache.get('inventory_items/8/1-a.jpg')).toBe('https://signed/1');
  });

  it('una ruta nunca guardada es un fallo de caché', () => {
    expect(buildCache().get('inventory_items/8/nope.jpg')).toBeUndefined();
  });

  it('getMany devuelve solo los aciertos, sin inventar entradas', () => {
    const cache = buildCache();
    cache.set('a.jpg', 'https://signed/a');
    cache.set('c.jpg', 'https://signed/c');

    const hits = cache.getMany(['a.jpg', 'b.jpg', 'c.jpg']);

    expect(hits.size).toBe(2);
    expect(hits.get('a.jpg')).toBe('https://signed/a');
    expect(hits.has('b.jpg')).toBe(false);
  });

  it('invalidate borra la entrada (reemplazar la imagen no puede dejar la URL vieja)', () => {
    const cache = buildCache();
    cache.set('a.jpg', 'https://signed/a');
    cache.invalidate('a.jpg');

    expect(cache.get('a.jpg')).toBeUndefined();
  });

  it('invalidate con null/undefined no rompe ni borra nada', () => {
    const cache = buildCache();
    cache.set('a.jpg', 'https://signed/a');

    cache.invalidate(null);
    cache.invalidate(undefined);

    expect(cache.get('a.jpg')).toBe('https://signed/a');
  });

  it('invalidateMany ignora los nulos y borra el resto', () => {
    const cache = buildCache();
    cache.set('a.jpg', 'https://signed/a');
    cache.set('b.jpg', 'https://signed/b');

    cache.invalidateMany(['a.jpg', null, undefined, 'b.jpg']);

    expect(cache.size).toBe(0);
  });

  it('invalidateMany sin nada que borrar no falla', () => {
    const cache = buildCache();
    expect(() => cache.invalidateMany([null, undefined])).not.toThrow();
  });

  it('el TTL efectivo queda acotado por la vigencia de la firma', () => {
    const cache = buildCache({ cacheTtlSeconds: 86400, signedUrlTtlSeconds: 3600 });
    expect(cache.ttlSeconds).toBe(1800);
  });

  it('clear vacía el caché entero', () => {
    const cache = buildCache();
    cache.set('a.jpg', 'https://signed/a');
    cache.set('b.jpg', 'https://signed/b');

    cache.clear();

    expect(cache.size).toBe(0);
  });
});
