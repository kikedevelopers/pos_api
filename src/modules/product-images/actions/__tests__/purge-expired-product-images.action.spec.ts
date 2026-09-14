import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import type { Product } from '@/modules/products/entities/product.entity';

import { PurgeExpiredProductImagesAction } from '../purge-expired-product-images.action';
import { ProductImageStorageService } from '../../product-image-storage.service';
import { ProductImageUrlCache } from '../../product-image-url.cache';

/**
 * Purga de las imágenes de productos archivados que ya cumplieron su retención.
 *
 * La regla dura: la fila se despunta SIEMPRE, aunque GCS no pueda borrar. Si no,
 * el mismo borrado fallido se reintentaría cada día para siempre.
 */

interface ExpiredRow {
  id: string;
  company_id: string;
  image: string | null;
}

async function buildHarness(options: {
  expired: ExpiredRow[];
  removeFails?: boolean;
  isConfigured?: boolean;
}) {
  const updates: Array<{ criteria: unknown; patch: Record<string, unknown> }> = [];
  const managerMock = {
    update: jest.fn((_e: unknown, criteria: unknown, patch: Record<string, unknown>) => {
      updates.push({ criteria, patch });
      return Promise.resolve({ affected: 1, generatedMaps: [], raw: [] });
    }),
  };

  const queryBuilder = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn(() => Promise.resolve(options.expired as unknown as Product[])),
  };

  const dataSourceMock = {
    getRepository: jest.fn(() => ({ createQueryBuilder: jest.fn(() => queryBuilder) })),
    transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
  };

  const remove = jest.fn(() => Promise.resolve(!options.removeFails));
  const cacheMock = { invalidate: jest.fn() };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PurgeExpiredProductImagesAction,
      { provide: DataSource, useValue: dataSourceMock },
      {
        provide: ProductImageStorageService,
        useValue: {
          prefix: 'inventory_items',
          isConfigured: options.isConfigured ?? true,
          remove,
        },
      },
      { provide: ProductImageUrlCache, useValue: cacheMock },
    ],
  }).compile();

  return {
    action: module.get(PurgeExpiredProductImagesAction),
    remove,
    cache: cacheMock,
    updates: () => updates,
    queryBuilder,
  };
}

const ROW = { id: '10', company_id: '42', image: 'inventory_items/42/10-a.jpg' };

describe('PurgeExpiredProductImagesAction', () => {
  it('borra el objeto y despunta la fila', async () => {
    const h = await buildHarness({ expired: [ROW] });

    const result = await h.action.execute();

    expect(result).toEqual({ purged: 1, failed: 0 });
    expect(h.remove).toHaveBeenCalledWith('inventory_items/42/10-a.jpg');
    expect(h.updates()[0].patch).toEqual({ image: null, image_purge_at: null });
  });

  it('invalida la URL cacheada de lo purgado', async () => {
    const h = await buildHarness({ expired: [ROW] });

    await h.action.execute();

    expect(h.cache.invalidate).toHaveBeenCalledWith('inventory_items/42/10-a.jpg');
  });

  it('despunta la fila aunque GCS no haya podido borrar (no se reintenta eternamente)', async () => {
    const h = await buildHarness({ expired: [ROW], removeFails: true });

    const result = await h.action.execute();

    expect(result).toEqual({ purged: 1, failed: 1 });
    expect(h.updates()[0].patch).toEqual({ image: null, image_purge_at: null });
  });

  it('sin nada vencido no toca ni el bucket ni la BD', async () => {
    const h = await buildHarness({ expired: [] });

    const result = await h.action.execute();

    expect(result).toEqual({ purged: 0, failed: 0 });
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.updates()).toHaveLength(0);
  });

  it('sin bucket configurado no consulta la BD siquiera', async () => {
    const h = await buildHarness({ expired: [ROW], isConfigured: false });

    const result = await h.action.execute();

    expect(result).toEqual({ purged: 0, failed: 0 });
    expect(h.queryBuilder.getMany).not.toHaveBeenCalled();
  });

  it('procesa varias filas de companies distintas', async () => {
    const h = await buildHarness({
      expired: [ROW, { id: '11', company_id: '9', image: 'inventory_items/9/11-b.jpg' }],
    });

    const result = await h.action.execute();

    expect(result.purged).toBe(2);
    expect(h.remove).toHaveBeenCalledTimes(2);
  });

  it('una ruta fuera de la carpeta de su company se despunta SIN borrar', async () => {
    const h = await buildHarness({
      expired: [{ id: '10', company_id: '42', image: 'backups/dump.sql' }],
    });

    const result = await h.action.execute();

    expect(h.remove).not.toHaveBeenCalled();
    expect(result.purged).toBe(1);
    expect(h.updates()[0].patch).toEqual({ image: null, image_purge_at: null });
  });

  it('el UPDATE filtra por company_id además del id (nunca cross-tenant)', async () => {
    const h = await buildHarness({ expired: [ROW] });

    await h.action.execute();

    expect(h.updates()[0].criteria).toEqual({ id: '10', company_id: '42' });
  });
});
