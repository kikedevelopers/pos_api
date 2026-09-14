import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CopyProductImageAction } from '../copy-product-image.action';
import { ProductImageStorageService } from '../../product-image-storage.service';

/**
 * Copiar la imagen al duplicar un producto o clonarlo a una sucursal.
 *
 * La razón de copiar el ARCHIVO y no el string: dos filas apuntando al mismo
 * objeto significan que quitar la imagen en una rompe la otra, en silencio.
 */

async function buildHarness(options: { copyFails?: boolean; isConfigured?: boolean } = {}) {
  const updates: Array<{ criteria: unknown; patch: Record<string, unknown> }> = [];
  const managerMock = {
    update: jest.fn((_e: unknown, criteria: unknown, patch: Record<string, unknown>) => {
      updates.push({ criteria, patch });
      return Promise.resolve({ affected: 1, generatedMaps: [], raw: [] });
    }),
  };

  const dataSourceMock = {
    transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
  };

  const copy = jest.fn(() =>
    options.copyFails ? Promise.reject(new Error('objeto no existe')) : Promise.resolve(),
  );

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      CopyProductImageAction,
      { provide: DataSource, useValue: dataSourceMock },
      {
        provide: ProductImageStorageService,
        useValue: {
          prefix: 'inventory_items',
          isConfigured: options.isConfigured ?? true,
          copy,
        },
      },
    ],
  }).compile();

  return { action: module.get(CopyProductImageAction), copy, updates: () => updates };
}

describe('CopyProductImageAction · una copia', () => {
  it('copia el objeto a una ruta propia del producto destino', async () => {
    const h = await buildHarness();

    const result = await h.action.execute({
      sourceImage: 'inventory_items/42/7-abc.png',
      targetProductId: 100,
      targetCompanyId: 42,
    });

    expect(result).toMatch(/^inventory_items\/42\/100-[0-9a-f]{16}\.png$/);
    expect(h.copy).toHaveBeenCalledWith('inventory_items/42/7-abc.png', result);
  });

  it('la ruta destino NUNCA es la del origen', async () => {
    const h = await buildHarness();

    const result = await h.action.execute({
      sourceImage: 'inventory_items/42/7-abc.png',
      targetProductId: 100,
      targetCompanyId: 42,
    });

    expect(result).not.toBe('inventory_items/42/7-abc.png');
  });

  it('conserva la extensión del original (el binario se copia tal cual)', async () => {
    const h = await buildHarness();

    const webp = await h.action.execute({
      sourceImage: 'inventory_items/42/7-abc.webp',
      targetProductId: 100,
      targetCompanyId: 42,
    });

    expect(webp).toMatch(/\.webp$/);
  });

  it('al clonar a una sucursal el archivo queda en la carpeta de ESA company', async () => {
    const h = await buildHarness();

    const result = await h.action.execute({
      sourceImage: 'inventory_items/42/7-abc.jpg',
      targetProductId: 500,
      targetCompanyId: 11,
    });

    expect(result).toMatch(/^inventory_items\/11\/500-/);
  });

  it('apunta la fila destino a su nueva ruta, filtrando por company', async () => {
    const h = await buildHarness();

    const result = await h.action.execute({
      sourceImage: 'inventory_items/42/7-abc.jpg',
      targetProductId: 100,
      targetCompanyId: 42,
    });

    expect(h.updates()[0]).toEqual({
      criteria: { id: '100', company_id: '42' },
      patch: { image: result },
    });
  });

  it('un origen sin imagen no hace nada', async () => {
    const h = await buildHarness();

    const result = await h.action.execute({
      sourceImage: null,
      targetProductId: 100,
      targetCompanyId: 42,
    });

    expect(result).toBeNull();
    expect(h.copy).not.toHaveBeenCalled();
    expect(h.updates()).toHaveLength(0);
  });

  it('si la copia falla el duplicado queda sin foto, pero NO se pierde el duplicado', async () => {
    const h = await buildHarness({ copyFails: true });

    const result = await h.action.execute({
      sourceImage: 'inventory_items/42/7-abc.jpg',
      targetProductId: 100,
      targetCompanyId: 42,
    });

    expect(result).toBeNull();
    expect(h.updates()).toHaveLength(0);
  });

  it('sin bucket configurado devuelve null sin tocar la red', async () => {
    const h = await buildHarness({ isConfigured: false });

    const result = await h.action.execute({
      sourceImage: 'inventory_items/42/7-abc.jpg',
      targetProductId: 100,
      targetCompanyId: 42,
    });

    expect(result).toBeNull();
    expect(h.copy).not.toHaveBeenCalled();
  });
});

describe('CopyProductImageAction · lote (clonar a sucursal)', () => {
  it('copia todas las imágenes del lote y devuelve cuántas logró', async () => {
    const h = await buildHarness();

    const copied = await h.action.executeMany(
      [
        { sourceImage: 'inventory_items/42/1-a.jpg', targetProductId: 101 },
        { sourceImage: 'inventory_items/42/2-b.jpg', targetProductId: 102 },
      ],
      11,
    );

    expect(copied).toBe(2);
    expect(h.copy).toHaveBeenCalledTimes(2);
  });

  it('omite los productos sin imagen', async () => {
    const h = await buildHarness();

    const copied = await h.action.executeMany(
      [
        { sourceImage: null, targetProductId: 101 },
        { sourceImage: 'inventory_items/42/2-b.jpg', targetProductId: 102 },
      ],
      11,
    );

    expect(copied).toBe(1);
    expect(h.copy).toHaveBeenCalledTimes(1);
  });

  it('un lote sin ninguna imagen no llama al bucket', async () => {
    const h = await buildHarness();

    const copied = await h.action.executeMany([{ sourceImage: null, targetProductId: 101 }], 11);

    expect(copied).toBe(0);
    expect(h.copy).not.toHaveBeenCalled();
  });

  it('procesa lotes mayores que el tope de concurrencia', async () => {
    const h = await buildHarness();
    const items = Array.from({ length: 12 }, (_, i) => ({
      sourceImage: `inventory_items/42/${i}-x.jpg`,
      targetProductId: 200 + i,
    }));

    const copied = await h.action.executeMany(items, 11);

    expect(copied).toBe(12);
  });

  it('si todas las copias fallan devuelve 0 sin lanzar', async () => {
    const h = await buildHarness({ copyFails: true });

    const copied = await h.action.executeMany(
      [{ sourceImage: 'inventory_items/42/1-a.jpg', targetProductId: 101 }],
      11,
    );

    expect(copied).toBe(0);
  });
});
