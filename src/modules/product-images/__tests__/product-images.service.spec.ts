import { Test, type TestingModule } from '@nestjs/testing';
import { In, IsNull, Not, type EntityManager } from 'typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import { CopyProductImageAction } from '../actions/copy-product-image.action';
import { PurgeExpiredProductImagesAction } from '../actions/purge-expired-product-images.action';
import { RemoveProductImageAction } from '../actions/remove-product-image.action';
import { ResolveProductImageUrlsAction } from '../actions/resolve-product-image-urls.action';
import { UploadProductImageAction } from '../actions/upload-product-image.action';
import { ProductImageStorageService } from '../product-image-storage.service';
import { ProductImageUrlCache } from '../product-image-url.cache';
import { ProductImagesService } from '../product-images.service';

/**
 * El facade no tiene lógica salvo `markArchivedForPurge`, que es donde vive la
 * regla de negocio de la retención: archivar NO borra la imagen, le pone fecha.
 */

const RETENTION_DAYS = 7;

async function buildHarness(options: { maxSizeBytes?: number; isConfigured?: boolean } = {}) {
  const removedObjects: string[] = [];
  const removedFolders: number[] = [];
  const invalidatedPrefixes: string[] = [];
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ProductImagesService,
      {
        provide: ProductImageStorageService,
        useValue: {
          isConfigured: options.isConfigured ?? true,
          maxSizeBytes: options.maxSizeBytes ?? 2 * 1024 * 1024,
          retentionDaysAfterArchive: RETENTION_DAYS,
          prefix: 'inventory_items',
          companyPrefix: (companyId: number) => `inventory_items/${companyId}/`,
          remove: (objectName: string) => {
            removedObjects.push(objectName);
            return Promise.resolve(true);
          },
          removeCompanyFolder: (companyId: number) => {
            removedFolders.push(companyId);
            return Promise.resolve();
          },
        },
      },
      {
        provide: ProductImageUrlCache,
        useValue: {
          invalidate: jest.fn(),
          invalidateByPrefix: jest.fn((prefix: string) => {
            invalidatedPrefixes.push(prefix);
            return 0;
          }),
        },
      },
      { provide: UploadProductImageAction, useValue: { execute: jest.fn() } },
      { provide: RemoveProductImageAction, useValue: { execute: jest.fn() } },
      { provide: ResolveProductImageUrlsAction, useValue: { execute: jest.fn() } },
      { provide: CopyProductImageAction, useValue: { execute: jest.fn(), executeMany: jest.fn() } },
      { provide: PurgeExpiredProductImagesAction, useValue: { execute: jest.fn() } },
    ],
  }).compile();

  const updates: Array<{ criteria: unknown; patch: Record<string, unknown> }> = [];
  const entitiesUpdated: unknown[] = [];
  const manager = {
    update: jest.fn((entity: unknown, criteria: unknown, patch: Record<string, unknown>) => {
      entitiesUpdated.push(entity);
      updates.push({ criteria, patch });
      return Promise.resolve({ affected: 1 });
    }),
  } as unknown as EntityManager;

  return {
    service: module.get(ProductImagesService),
    manager,
    updates: () => updates,
    entitiesUpdated: () => entitiesUpdated,
    removedObjects: () => removedObjects,
    removedFolders: () => removedFolders,
    invalidatedPrefixes: () => invalidatedPrefixes,
  };
}

describe('ProductImagesService · getSettings', () => {
  it('reporta el límite real del servidor en MB', async () => {
    const h = await buildHarness({ maxSizeBytes: 2 * 1024 * 1024 });

    expect(h.service.getSettings()).toEqual({
      enabled: true,
      max_size_mb: 2,
      recommended_width: 800,
      recommended_height: 800,
      accepted_formats: ['jpg', 'png', 'webp'],
    });
  });

  it('sin bucket configurado el front sabe que debe ocultar el campo', async () => {
    const h = await buildHarness({ isConfigured: false });

    expect(h.service.getSettings().enabled).toBe(false);
  });

  it('un límite no entero se reporta con decimales', async () => {
    const h = await buildHarness({ maxSizeBytes: 1.5 * 1024 * 1024 });

    expect(h.service.getSettings().max_size_mb).toBe(1.5);
  });
});

describe('ProductImagesService · markArchivedForPurge', () => {
  it('programa la purga a los días de retención configurados', async () => {
    const h = await buildHarness();
    const before = Date.now();

    await h.service.markArchivedForPurge(h.manager, 42, [10, 11]);

    const purgeAt = h.updates()[0].patch.image_purge_at as Date;
    const expected = before + RETENTION_DAYS * 24 * 60 * 60 * 1000;
    // Margen de un minuto: la aritmética de fechas no tiene por qué ser exacta
    // al milisegundo, pero el DÍA sí tiene que ser el séptimo.
    expect(Math.abs(purgeAt.getTime() - expected)).toBeLessThan(60_000);
  });

  it('NO borra nada: archivar solo pone la fecha', async () => {
    const h = await buildHarness();

    await h.service.markArchivedForPurge(h.manager, 42, [10]);

    expect(h.updates()[0].patch).not.toHaveProperty('image', null);
    expect(Object.keys(h.updates()[0].patch)).toEqual(['image_purge_at']);
  });

  it('solo marca las filas CON imagen', async () => {
    const h = await buildHarness();

    await h.service.markArchivedForPurge(h.manager, 42, [10, 11]);

    expect(h.updates()[0].criteria).toEqual({
      id: In(['10', '11']),
      company_id: '42',
      image: Not(IsNull()),
    });
  });

  it('filtra por company: nunca marca productos de otro tenant', async () => {
    const h = await buildHarness();

    await h.service.markArchivedForPurge(h.manager, 9, [10]);

    expect((h.updates()[0].criteria as { company_id: string }).company_id).toBe('9');
  });

  it('sin ids no toca la base', async () => {
    const h = await buildHarness();

    await h.service.markArchivedForPurge(h.manager, 42, []);

    expect(h.updates()).toHaveLength(0);
  });

  it('actualiza la entidad Product', async () => {
    const h = await buildHarness();

    await h.service.markArchivedForPurge(h.manager, 42, [10]);

    expect(h.entitiesUpdated()).toEqual([Product]);
  });
});

/**
 * Borrados DUROS: cuando las filas de `products` desaparecen (eliminar un
 * tenant, vaciar su inventario, reimportar sobre él), la única referencia a los
 * archivos se va con ellas. Sin esta limpieza el bucket acumularía para siempre
 * fotos de negocios que ya no existen — y se seguiría pagando su espacio.
 */
describe('ProductImagesService · limpieza de borrados duros', () => {
  it('removeAllForCompany borra la carpeta entera de la company', async () => {
    const h = await buildHarness();

    await h.service.removeAllForCompany(42);

    expect(h.removedFolders()).toEqual([42]);
  });

  it('removeAllForCompany saca del caché las URLs de esa carpeta', async () => {
    const h = await buildHarness();

    await h.service.removeAllForCompany(42);

    // Si no, el listado seguiría entregando enlaces a objetos ya borrados.
    expect(h.invalidatedPrefixes()).toEqual(['inventory_items/42/']);
  });

  it('sin bucket configurado no intenta borrar nada', async () => {
    const h = await buildHarness({ isConfigured: false });

    await h.service.removeAllForCompany(42);

    expect(h.removedFolders()).toHaveLength(0);
  });

  it('removeImages borra las rutas indicadas y las cuenta', async () => {
    const h = await buildHarness();

    const removed = await h.service.removeImages(
      ['inventory_items/42/1-a.jpg', 'inventory_items/42/2-b.jpg'],
      42,
    );

    expect(removed).toBe(2);
    expect(h.removedObjects()).toEqual([
      'inventory_items/42/1-a.jpg',
      'inventory_items/42/2-b.jpg',
    ]);
  });

  it('removeImages NO toca la ruta de otra company', async () => {
    const h = await buildHarness();

    const removed = await h.service.removeImages(['inventory_items/9/1-ajena.jpg'], 42);

    expect(removed).toBe(0);
    expect(h.removedObjects()).toHaveLength(0);
  });

  it('removeImages con la lista vacía no hace nada', async () => {
    const h = await buildHarness();

    expect(await h.service.removeImages([], 42)).toBe(0);
  });
});
