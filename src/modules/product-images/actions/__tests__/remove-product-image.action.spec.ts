import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import type { Product } from '@/modules/products/entities/product.entity';

import { RemoveProductImageAction } from '../remove-product-image.action';
import { ProductImageStorageService } from '../../product-image-storage.service';
import { ProductImageUrlCache } from '../../product-image-url.cache';

const COMPANY_ID = 42;
const ACTOR = { id: 7, fullName: 'Kike Pacheco' };

async function buildHarness(product: Partial<Product> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const managerMock = {
    update: jest.fn((_e: unknown, _c: unknown, patch: Record<string, unknown>) => {
      updates.push(patch);
      return Promise.resolve({ affected: 1, generatedMaps: [], raw: [] });
    }),
  };

  const dataSourceMock = {
    getRepository: jest.fn(() => ({ findOne: jest.fn(() => Promise.resolve(product)) })),
    transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
  };

  const remove = jest.fn(() => Promise.resolve(true));
  const cacheMock = { invalidate: jest.fn() };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RemoveProductImageAction,
      { provide: DataSource, useValue: dataSourceMock },
      {
        provide: ProductImageStorageService,
        useValue: { prefix: 'inventory_items', isConfigured: true, remove },
      },
      { provide: ProductImageUrlCache, useValue: cacheMock },
    ],
  }).compile();

  return {
    action: module.get(RemoveProductImageAction),
    remove,
    cache: cacheMock,
    updates: () => updates,
  };
}

describe('RemoveProductImageAction', () => {
  it('borra el archivo del bucket y despunta la fila', async () => {
    const h = await buildHarness({ id: '10', image: 'inventory_items/42/10-a.jpg' });

    const result = await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      actor: ACTOR,
    });

    expect(result).toEqual({ product_id: 10, removed: true });
    expect(h.remove).toHaveBeenCalledWith('inventory_items/42/10-a.jpg');
    expect(h.updates()[0]).toMatchObject({ image: null, image_purge_at: null });
  });

  it('invalida la URL cacheada', async () => {
    const h = await buildHarness({ id: '10', image: 'inventory_items/42/10-a.jpg' });

    await h.action.execute({ productId: 10, companyId: COMPANY_ID, actor: ACTOR });

    expect(h.cache.invalidate).toHaveBeenCalledWith('inventory_items/42/10-a.jpg');
  });

  it('es idempotente: quitar la imagen de un producto que no tiene no falla', async () => {
    const h = await buildHarness({ id: '10', image: null });

    const result = await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      actor: ACTOR,
    });

    expect(result).toEqual({ product_id: 10, removed: false });
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.updates()).toHaveLength(0);
  });

  it('producto inexistente o de otra company → 404', async () => {
    const h = await buildHarness(null);

    await expect(
      h.action.execute({ productId: 999, companyId: COMPANY_ID, actor: ACTOR }),
    ).rejects.toThrow(NotFoundException);
  });

  it('una ruta de otra company se desliga pero NO se borra del bucket', async () => {
    const h = await buildHarness({ id: '10', image: 'inventory_items/9/10-ajena.jpg' });

    const result = await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      actor: ACTOR,
    });

    expect(result.removed).toBe(true);
    expect(h.updates()[0]).toMatchObject({ image: null });
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('registra al actor como quien actualizó el producto', async () => {
    const h = await buildHarness({ id: '10', image: 'inventory_items/42/10-a.jpg' });

    await h.action.execute({ productId: 10, companyId: COMPANY_ID, actor: ACTOR });

    expect(h.updates()[0]).toMatchObject({ updated_by: 'Kike Pacheco', updated_by_id: '7' });
  });
});
