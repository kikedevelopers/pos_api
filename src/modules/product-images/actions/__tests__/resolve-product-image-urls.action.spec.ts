import { Test, type TestingModule } from '@nestjs/testing';

import { ResolveProductImageUrlsAction } from '../resolve-product-image-urls.action';
import { ImageProxySigner } from '../../image-proxy-signer.service';
import { ProductImageStorageService } from '../../product-image-storage.service';
import { ProductImageUrlCache } from '../../product-image-url.cache';

/**
 * Esta action resuelve en lote las URLs-proxy de un listado (inventario o POS).
 * Firmar es LOCAL (HMAC, ver ImageProxySigner): instantáneo y sin red, así que ya
 * no hay lotes, concurrencia ni fallos de firma. El caché se mantiene para dar
 * una URL ESTABLE (misma URL entre requests → el navegador la reutiliza).
 *
 * El caché aquí es real (no un doble) para verificar aciertos y repoblado.
 */

const COMPANY_ID = 42;
const IMG_A = 'inventory_items/42/1-a.jpg';
const IMG_B = 'inventory_items/42/2-b.jpg';

const CONFIG = {
  bucket: 'placepos-bucket-1',
  prefix: 'inventory_items',
  maxSizeBytes: 2 * 1024 * 1024,
  signedUrlTtlSeconds: 86400,
  cacheTtlSeconds: 21600,
  retentionDaysAfterArchive: 7,
};

/** URL-proxy determinista por objeto (el firmante real usa HMAC + exp). */
function proxyUrl(objectName: string): string {
  return `/product-images/serve?o=${objectName}&e=1&s=sig`;
}

async function buildHarness(options: { isConfigured?: boolean } = {}) {
  const buildUrl = jest.fn((objectName: string) => proxyUrl(objectName));

  const cache = new ProductImageUrlCache({ getOrThrow: () => CONFIG } as never);

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ResolveProductImageUrlsAction,
      {
        provide: ProductImageStorageService,
        useValue: {
          prefix: 'inventory_items',
          isConfigured: options.isConfigured ?? true,
        },
      },
      { provide: ProductImageUrlCache, useValue: cache },
      { provide: ImageProxySigner, useValue: { buildUrl } },
    ],
  }).compile();

  return { action: module.get(ResolveProductImageUrlsAction), buildUrl, cache };
}

describe('ResolveProductImageUrlsAction · resolución en lote', () => {
  it('firma cada ruta y devuelve el mapa ruta → URL', async () => {
    const h = await buildHarness();

    const urls = await h.action.execute([IMG_A, IMG_B], COMPANY_ID);

    expect(urls.get(IMG_A)).toBe(proxyUrl(IMG_A));
    expect(urls.get(IMG_B)).toBe(proxyUrl(IMG_B));
  });

  it('ignora nulos y undefined del listado', async () => {
    const h = await buildHarness();

    const urls = await h.action.execute([IMG_A, null, undefined, IMG_B], COMPANY_ID);

    expect(urls.size).toBe(2);
    expect(h.buildUrl).toHaveBeenCalledTimes(2);
  });

  it('deduplica: la misma ruta repetida se firma UNA vez', async () => {
    const h = await buildHarness();

    await h.action.execute([IMG_A, IMG_A, IMG_A], COMPANY_ID);

    expect(h.buildUrl).toHaveBeenCalledTimes(1);
  });

  it('un listado sin ninguna imagen no firma nada', async () => {
    const h = await buildHarness();

    const urls = await h.action.execute([null, null], COMPANY_ID);

    expect(urls.size).toBe(0);
    expect(h.buildUrl).not.toHaveBeenCalled();
  });

  it('resuelve listados grandes', async () => {
    const h = await buildHarness();
    const names = Array.from({ length: 25 }, (_, i) => `inventory_items/42/${i}-x.jpg`);

    const urls = await h.action.execute(names, COMPANY_ID);

    expect(urls.size).toBe(25);
    expect(h.buildUrl).toHaveBeenCalledTimes(25);
  });
});

describe('ResolveProductImageUrlsAction · caché', () => {
  it('la segunda llamada NO vuelve a firmar (URL estable)', async () => {
    const h = await buildHarness();

    await h.action.execute([IMG_A, IMG_B], COMPANY_ID);
    await h.action.execute([IMG_A, IMG_B], COMPANY_ID);

    expect(h.buildUrl).toHaveBeenCalledTimes(2);
  });

  it('solo firma lo que falta cuando el listado crece', async () => {
    const h = await buildHarness();

    await h.action.execute([IMG_A], COMPANY_ID);
    h.buildUrl.mockClear();
    await h.action.execute([IMG_A, IMG_B], COMPANY_ID);

    expect(h.buildUrl).toHaveBeenCalledTimes(1);
    expect(h.buildUrl).toHaveBeenCalledWith(IMG_B);
  });

  it('una ruta invalidada se vuelve a firmar', async () => {
    const h = await buildHarness();

    await h.action.execute([IMG_A], COMPANY_ID);
    h.cache.invalidate(IMG_A);
    h.buildUrl.mockClear();
    await h.action.execute([IMG_A], COMPANY_ID);

    expect(h.buildUrl).toHaveBeenCalledTimes(1);
  });

  it('sin bucket configurado devuelve vacío sin firmar', async () => {
    const h = await buildHarness({ isConfigured: false });

    const urls = await h.action.execute([IMG_A], COMPANY_ID);

    expect(urls.size).toBe(0);
    expect(h.buildUrl).not.toHaveBeenCalled();
  });
});

/**
 * Firmar una URL es DAR ACCESO al archivo. `products.image` la escribe solo el
 * servidor, pero un respaldo importado desde otra empresa o una migración a mano
 * pueden dejar una fila apuntando al objeto de otro tenant; firmarla sería
 * servirle a un negocio la foto de otro. Es el mismo cinturón que ya se aplica
 * al borrar y al purgar.
 */
describe('ResolveProductImageUrlsAction · aislamiento entre negocios', () => {
  it('NO firma la ruta de otra company', async () => {
    const h = await buildHarness();

    const urls = await h.action.execute(['inventory_items/9/1-ajena.jpg'], COMPANY_ID);

    expect(urls.size).toBe(0);
    expect(h.buildUrl).not.toHaveBeenCalled();
  });

  it('firma las propias y descarta las ajenas en el mismo lote', async () => {
    const h = await buildHarness();

    const urls = await h.action.execute([IMG_A, 'inventory_items/9/1-ajena.jpg'], COMPANY_ID);

    expect(urls.get(IMG_A)).toBe(proxyUrl(IMG_A));
    expect(urls.has('inventory_items/9/1-ajena.jpg')).toBe(false);
    expect(h.buildUrl).toHaveBeenCalledTimes(1);
  });

  it('una company cuyo id es prefijo de otra no cuela (42 vs 421)', async () => {
    const h = await buildHarness();

    const urls = await h.action.execute(['inventory_items/421/1-a.jpg'], COMPANY_ID);

    expect(urls.size).toBe(0);
  });

  it('tampoco firma rutas de otra carpeta del bucket (respaldos)', async () => {
    const h = await buildHarness();

    const urls = await h.action.execute(['backups/prod-placepos-2026.dump'], COMPANY_ID);

    expect(urls.size).toBe(0);
    expect(h.buildUrl).not.toHaveBeenCalled();
  });
});
