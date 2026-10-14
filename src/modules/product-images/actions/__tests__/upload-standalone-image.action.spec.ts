import { BadRequestException } from '@nestjs/common';

import type { ImageProxySigner } from '../../image-proxy-signer.service';
import type { ProductImageStorageService } from '../../product-image-storage.service';
import type { ProductImageUrlCache } from '../../product-image-url.cache';
import { UploadStandaloneImageAction } from '../upload-standalone-image.action';

/** PNG mínimo válido (magic bytes) para pasar la validación por contenido. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 1),
]);

describe('UploadStandaloneImageAction', () => {
  let action: UploadStandaloneImageAction;
  let uploadSpy: jest.Mock;
  let removeSpy: jest.Mock;

  const build = (): void => {
    uploadSpy = jest.fn(() => Promise.resolve());
    removeSpy = jest.fn(() => Promise.resolve(true));
    const storage = {
      maxSizeBytes: 2 * 1024 * 1024,
      prefix: 'inventory_items',
      upload: uploadSpy,
      remove: removeSpy,
    } as unknown as ProductImageStorageService;
    const cache = { invalidate: jest.fn(), set: jest.fn() } as unknown as ProductImageUrlCache;
    const signer = { buildUrl: (o: string) => `/product-images/serve?o=${o}` } as unknown as ImageProxySigner;
    action = new UploadStandaloneImageAction(storage, cache, signer);
  };

  beforeEach(build);

  const actor = { id: 1, fullName: 'Owner' };

  it('sube bajo inventory_items/<company>/ con el keyHint y devuelve la URL firmada', async () => {
    const result = await action.execute({
      companyId: 13,
      file: { buffer: PNG, mimetype: 'image/png', size: PNG.length },
      keyHint: 'catalog-cover',
      actor,
    });

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const uploaded = uploadSpy.mock.calls[0][0] as { objectName: string; contentType: string };
    expect(uploaded.objectName).toMatch(/^inventory_items\/13\/catalog-cover-[0-9a-f]+\.png$/);
    expect(uploaded.contentType).toBe('image/png');
    expect(result.object).toBe(uploaded.objectName);
    expect(result.url).toBe(`/product-images/serve?o=${uploaded.objectName}`);
  });

  it('borra la imagen anterior de la misma company tras subir la nueva', async () => {
    await action.execute({
      companyId: 13,
      file: { buffer: PNG, mimetype: 'image/png', size: PNG.length },
      keyHint: 'catalog-cover',
      previousObject: 'inventory_items/13/catalog-cover-old.png',
      actor,
    });
    expect(removeSpy).toHaveBeenCalledWith('inventory_items/13/catalog-cover-old.png');
  });

  it('NO borra una ruta anterior que no pertenece a la company', async () => {
    await action.execute({
      companyId: 13,
      file: { buffer: PNG, mimetype: 'image/png', size: PNG.length },
      keyHint: 'catalog-cover',
      previousObject: 'inventory_items/999/catalog-cover-ajena.png',
      actor,
    });
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('archivo inválido (no imagen) ⇒ 400 y no sube nada', async () => {
    await expect(
      action.execute({
        companyId: 13,
        file: { buffer: Buffer.from('not-an-image'), mimetype: 'image/png', size: 12 },
        keyHint: 'catalog-cover',
        actor,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});
