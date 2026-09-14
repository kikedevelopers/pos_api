import { Test, type TestingModule } from '@nestjs/testing';

import { ResolveProductImageUrlsAction } from '../resolve-product-image-urls.action';
import { ProductImageStorageService } from '../../product-image-storage.service';
import { ProductImageUrlCache } from '../../product-image-url.cache';

/**
 * Esta action es el motivo por el que existe el caché: un listado de inventario
 * o del POS pide TODAS las imágenes de golpe, y firmar una por producto en cada
 * refresco agotaría la cuota de Google.
 *
 * El caché aquí es real (no un doble) para verificar el comportamiento de punta
 * a punta: aciertos, fallos y repoblado.
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

async function buildHarness(options: { isConfigured?: boolean; failFor?: string[] } = {}) {
  const failFor = new Set(options.failFor ?? []);
  const getSignedUrl = jest.fn((objectName: string) =>
    failFor.has(objectName)
      ? Promise.reject(new Error('permiso denegado'))
      : Promise.resolve(`https://signed/${objectName}`),
  );

  const cache = new ProductImageUrlCache({ getOrThrow: () => CONFIG } as never);

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ResolveProductImageUrlsAction,
      {
        provide: ProductImageStorageService,
        useValue: {
          prefix: 'inventory_items',
          isConfigured: options.isConfigured ?? true,
          getSignedUrl,
        },
      },
      { provide: ProductImageUrlCache, useValue: cache },
    ],
  }).compile();

  return { action: module.get(ResolveProductImageUrlsAction), getSignedUrl, cache };
}

describe('ResolveProductImageUrlsAction · resolución en lote', () => {
  it('firma cada ruta y devuelve el mapa ruta → URL', async () => {
    const h = await buildHarness();

    const urls = await h.action.execute([IMG_A, IMG_B], COMPANY_ID);

    expect(urls.get(IMG_A)).toBe(`https://signed/${IMG_A}`);
    expect(urls.get(IMG_B)).toBe(`https://signed/${IMG_B}`);
  });

  it('ignora nulos y undefined del listado', async () => {
    const h = await buildHarness();

    const urls = await h.action.execute([IMG_A, null, undefined, IMG_B], COMPANY_ID);

    expect(urls.size).toBe(2);
    expect(h.getSignedUrl).toHaveBeenCalledTimes(2);
  });

  it('deduplica: la misma ruta repetida se firma UNA vez', async () => {
    const h = await buildHarness();

    await h.action.execute([IMG_A, IMG_A, IMG_A], COMPANY_ID);

    expect(h.getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('un listado sin ninguna imagen no llama a GCS', async () => {
    const h = await buildHarness();

    const urls = await h.action.execute([null, null], COMPANY_ID);

    expect(urls.size).toBe(0);
    expect(h.getSignedUrl).not.toHaveBeenCalled();
  });

  it('resuelve lotes grandes por encima del tope de concurrencia', async () => {
    const h = await buildHarness();
    const names = Array.from({ length: 25 }, (_, i) => `inventory_items/42/${i}-x.jpg`);

    const urls = await h.action.execute(names, COMPANY_ID);

    expect(urls.size).toBe(25);
    expect(h.getSignedUrl).toHaveBeenCalledTimes(25);
  });
});

describe('ResolveProductImageUrlsAction · caché', () => {
  it('la segunda llamada NO vuelve a firmar (es el ahorro de cuota)', async () => {
    const h = await buildHarness();

    await h.action.execute([IMG_A, IMG_B], COMPANY_ID);
    await h.action.execute([IMG_A, IMG_B], COMPANY_ID);

    expect(h.getSignedUrl).toHaveBeenCalledTimes(2);
  });

  it('solo firma lo que falta cuando el listado crece', async () => {
    const h = await buildHarness();

    await h.action.execute([IMG_A], COMPANY_ID);
    h.getSignedUrl.mockClear();
    await h.action.execute([IMG_A, IMG_B], COMPANY_ID);

    expect(h.getSignedUrl).toHaveBeenCalledTimes(1);
    expect(h.getSignedUrl).toHaveBeenCalledWith(IMG_B);
  });

  it('una ruta invalidada se vuelve a firmar', async () => {
    const h = await buildHarness();

    await h.action.execute([IMG_A], COMPANY_ID);
    h.cache.invalidate(IMG_A);
    h.getSignedUrl.mockClear();
    await h.action.execute([IMG_A], COMPANY_ID);

    expect(h.getSignedUrl).toHaveBeenCalledTimes(1);
  });
});

describe('ResolveProductImageUrlsAction · degradación', () => {
  it('una firma fallida no rompe el listado: esa ruta queda fuera del mapa', async () => {
    const h = await buildHarness({ failFor: [IMG_B] });

    const urls = await h.action.execute([IMG_A, IMG_B], COMPANY_ID);

    expect(urls.get(IMG_A)).toBe(`https://signed/${IMG_A}`);
    expect(urls.has(IMG_B)).toBe(false);
  });

  it('una firma fallida NO se cachea (se reintenta en el siguiente listado)', async () => {
    const h = await buildHarness({ failFor: [IMG_B] });

    await h.action.execute([IMG_B], COMPANY_ID);
    h.getSignedUrl.mockClear();
    await h.action.execute([IMG_B], COMPANY_ID);

    expect(h.getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('sin bucket configurado devuelve vacío sin intentar firmar', async () => {
    const h = await buildHarness({ isConfigured: false });

    const urls = await h.action.execute([IMG_A], COMPANY_ID);

    expect(urls.size).toBe(0);
    expect(h.getSignedUrl).not.toHaveBeenCalled();
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
    expect(h.getSignedUrl).not.toHaveBeenCalled();
  });

  it('firma las propias y descarta las ajenas en el mismo lote', async () => {
    const h = await buildHarness();

    const urls = await h.action.execute([IMG_A, 'inventory_items/9/1-ajena.jpg'], COMPANY_ID);

    expect(urls.get(IMG_A)).toBe(`https://signed/${IMG_A}`);
    expect(urls.has('inventory_items/9/1-ajena.jpg')).toBe(false);
    expect(h.getSignedUrl).toHaveBeenCalledTimes(1);
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
    expect(h.getSignedUrl).not.toHaveBeenCalled();
  });
});
