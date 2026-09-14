import {
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import type { Product } from '@/modules/products/entities/product.entity';

import { UploadProductImageAction } from '../upload-product-image.action';
import { ProductImageStorageService } from '../../product-image-storage.service';
import { ProductImageUrlCache } from '../../product-image-url.cache';

/**
 * Contrato de subir/reemplazar la imagen de un item.
 *
 * Lo crítico que se fija aquí es el ORDEN: primero se sube la nueva y se apunta
 * la fila, y SOLO después se borra la anterior. Al revés, cualquier fallo de red
 * dejaría al producto sin ninguna imagen.
 */

const COMPANY_ID = 42;
const ACTOR = { id: 7, fullName: 'Kike Pacheco' };
const MAX = 2 * 1024 * 1024;

function jpeg(size = 128): Buffer {
  const buffer = Buffer.alloc(size, 0x20);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  return buffer;
}

interface HarnessOptions {
  /** Producto existente. `null` = no existe o es de otra company. */
  product: Partial<Product> | null;
  /** Simula que GCS rechaza la subida. */
  uploadFails?: boolean;
}

async function buildHarness(options: HarnessOptions) {
  const updates: Array<Record<string, unknown>> = [];
  const managerMock = {
    update: jest.fn((_entity: unknown, _criteria: unknown, patch: Record<string, unknown>) => {
      updates.push(patch);
      return Promise.resolve({ affected: 1, generatedMaps: [], raw: [] });
    }),
  };

  const dataSourceMock = {
    getRepository: jest.fn(() => ({
      findOne: jest.fn(() => Promise.resolve(options.product)),
    })),
    transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
  };

  /** Payload con el que se llamó a `storage.upload`, ya tipado. */
  interface UploadCall {
    objectName: string;
    contentType: string;
    metadata: Record<string, string>;
  }
  const uploadCalls: UploadCall[] = [];
  const upload = jest.fn((params: UploadCall) => {
    uploadCalls.push(params);
    return options.uploadFails ? Promise.reject(new Error('GCS caído')) : Promise.resolve();
  });
  const remove = jest.fn(() => Promise.resolve(true));
  const getSignedUrl = jest.fn((objectName: string) =>
    Promise.resolve(`https://signed/${objectName}`),
  );

  const storageMock = {
    prefix: 'inventory_items',
    maxSizeBytes: MAX,
    isConfigured: true,
    upload,
    remove,
    getSignedUrl,
  };

  const cacheMock = { invalidate: jest.fn(), set: jest.fn() };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      UploadProductImageAction,
      { provide: DataSource, useValue: dataSourceMock },
      { provide: ProductImageStorageService, useValue: storageMock },
      { provide: ProductImageUrlCache, useValue: cacheMock },
    ],
  }).compile();

  return {
    action: module.get(UploadProductImageAction),
    upload,
    uploadCalls: () => uploadCalls,
    remove,
    getSignedUrl,
    cache: cacheMock,
    updates: () => updates,
  };
}

const ACTIVE_PRODUCT: Partial<Product> = {
  id: '10',
  name: 'ARROZ DIANA',
  image: null,
  is_archived: false,
};

describe('UploadProductImageAction · caso feliz', () => {
  it('sube el archivo y devuelve ruta + URL firmada', async () => {
    const h = await buildHarness({ product: ACTIVE_PRODUCT });

    const result = await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      file: { buffer: jpeg(), mimetype: 'image/jpeg' },
      actor: ACTOR,
    });

    expect(result.product_id).toBe(10);
    expect(result.image).toMatch(/^inventory_items\/42\/10-[0-9a-f]{16}\.jpg$/);
    expect(result.image_url).toBe(`https://signed/${result.image}`);
  });

  it('guarda la RUTA en la fila, no la URL (la URL caduca)', async () => {
    const h = await buildHarness({ product: ACTIVE_PRODUCT });

    const result = await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      file: { buffer: jpeg(), mimetype: 'image/jpeg' },
      actor: ACTOR,
    });

    expect(h.updates()[0]).toMatchObject({ image: result.image, image_purge_at: null });
  });

  it('sube con el content-type real y metadatos de auditoría', async () => {
    const h = await buildHarness({ product: ACTIVE_PRODUCT });

    await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      file: { buffer: jpeg(), mimetype: 'image/png' }, // miente el cliente
      actor: ACTOR,
    });

    const [call] = h.uploadCalls();
    expect(call.contentType).toBe('image/jpeg');
    expect(call.metadata).toMatchObject({
      companyId: '42',
      productId: '10',
      uploadedBy: 'Kike Pacheco',
    });
  });

  it('deja la URL en el caché para que el listado siguiente no vuelva a firmar', async () => {
    const h = await buildHarness({ product: ACTIVE_PRODUCT });

    const result = await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      file: { buffer: jpeg(), mimetype: 'image/jpeg' },
      actor: ACTOR,
    });

    expect(h.cache.set).toHaveBeenCalledWith(result.image, result.image_url);
  });

  it('registra al actor como quien actualizó el producto', async () => {
    const h = await buildHarness({ product: ACTIVE_PRODUCT });

    await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      file: { buffer: jpeg(), mimetype: 'image/jpeg' },
      actor: ACTOR,
    });

    expect(h.updates()[0]).toMatchObject({ updated_by: 'Kike Pacheco', updated_by_id: '7' });
  });
});

describe('UploadProductImageAction · reemplazo', () => {
  const WITH_IMAGE = { ...ACTIVE_PRODUCT, image: 'inventory_items/42/10-vieja.jpg' };

  it('borra la imagen anterior: nunca se acumulan dos del mismo producto', async () => {
    const h = await buildHarness({ product: WITH_IMAGE });

    await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      file: { buffer: jpeg(), mimetype: 'image/jpeg' },
      actor: ACTOR,
    });

    expect(h.remove).toHaveBeenCalledWith('inventory_items/42/10-vieja.jpg');
  });

  it('invalida la URL cacheada de la imagen anterior', async () => {
    const h = await buildHarness({ product: WITH_IMAGE });

    await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      file: { buffer: jpeg(), mimetype: 'image/jpeg' },
      actor: ACTOR,
    });

    expect(h.cache.invalidate).toHaveBeenCalledWith('inventory_items/42/10-vieja.jpg');
  });

  it('la ruta nueva es distinta de la vieja (invalida el caché del navegador)', async () => {
    const h = await buildHarness({ product: WITH_IMAGE });

    const result = await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      file: { buffer: jpeg(), mimetype: 'image/jpeg' },
      actor: ACTOR,
    });

    expect(result.image).not.toBe('inventory_items/42/10-vieja.jpg');
  });

  it('si la subida falla, NO se borra la imagen anterior ni se toca la fila', async () => {
    const h = await buildHarness({ product: WITH_IMAGE, uploadFails: true });

    await expect(
      h.action.execute({
        productId: 10,
        companyId: COMPANY_ID,
        file: { buffer: jpeg(), mimetype: 'image/jpeg' },
        actor: ACTOR,
      }),
    ).rejects.toThrow('GCS caído');

    expect(h.remove).not.toHaveBeenCalled();
    expect(h.updates()).toHaveLength(0);
  });

  it('una imagen anterior de OTRA company no se borra (archivo ajeno)', async () => {
    const h = await buildHarness({
      product: { ...ACTIVE_PRODUCT, image: 'inventory_items/9/10-ajena.jpg' },
    });

    await h.action.execute({
      productId: 10,
      companyId: COMPANY_ID,
      file: { buffer: jpeg(), mimetype: 'image/jpeg' },
      actor: ACTOR,
    });

    expect(h.remove).not.toHaveBeenCalled();
  });
});

describe('UploadProductImageAction · rechazos', () => {
  it('producto inexistente o de otra company → 404', async () => {
    const h = await buildHarness({ product: null });

    await expect(
      h.action.execute({
        productId: 999,
        companyId: COMPANY_ID,
        file: { buffer: jpeg(), mimetype: 'image/jpeg' },
        actor: ACTOR,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('producto archivado → 422 (su imagen ya está en cuenta regresiva)', async () => {
    const h = await buildHarness({ product: { ...ACTIVE_PRODUCT, is_archived: true } });

    await expect(
      h.action.execute({
        productId: 10,
        companyId: COMPANY_ID,
        file: { buffer: jpeg(), mimetype: 'image/jpeg' },
        actor: ACTOR,
      }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('archivo por encima del límite → 413 y no se sube nada', async () => {
    const h = await buildHarness({ product: ACTIVE_PRODUCT });

    await expect(
      h.action.execute({
        productId: 10,
        companyId: COMPANY_ID,
        file: { buffer: jpeg(MAX + 1), mimetype: 'image/jpeg' },
        actor: ACTOR,
      }),
    ).rejects.toThrow(PayloadTooLargeException);

    expect(h.upload).not.toHaveBeenCalled();
  });

  it('el producto se valida ANTES que el archivo (404 manda sobre el formato)', async () => {
    const h = await buildHarness({ product: null });

    await expect(
      h.action.execute({
        productId: 999,
        companyId: COMPANY_ID,
        file: { buffer: Buffer.from('esto no es una imagen'), mimetype: 'image/jpeg' },
        actor: ACTOR,
      }),
    ).rejects.toThrow(NotFoundException);
  });
});
