import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { ProductImagesService } from '@/modules/product-images/product-images.service';

import { UploadCatalogCoverAction } from '../actions/upload-catalog-cover.action';
import type { Company } from '../entities/company.entity';

/**
 * `UploadCatalogCoverAction`: sube la portada reutilizando el almacenamiento de
 * imágenes, apunta la columna de la company y devuelve la URL firmada. El
 * reemplazo de la portada anterior lo resuelve el servicio de imágenes.
 */
describe('UploadCatalogCoverAction', () => {
  let action: UploadCatalogCoverAction;
  let company: Company | null;
  let updatePatch: Partial<Company> | null;
  let uploadSpy: jest.Mock;

  const actor = { id: 7, fullName: 'Owner' };
  const file = { buffer: Buffer.from('x'), mimetype: 'image/png', size: 1 };

  const build = (): void => {
    updatePatch = null;
    const manager = {
      findOne: jest.fn(() => Promise.resolve(company)),
      update: jest.fn((_e: unknown, _w: unknown, patch: Partial<Company>) => {
        updatePatch = patch;
        if (company) Object.assign(company, patch);
        return Promise.resolve({ affected: 1 });
      }),
      findOneOrFail: jest.fn(() => Promise.resolve(company)),
    };
    const dataSource = { manager } as unknown as DataSource;
    uploadSpy = jest.fn(() =>
      Promise.resolve({ object: 'inventory_items/42/catalog-cover-abc.png', url: '/product-images/serve?o=cover' }),
    );
    const productImages = { uploadStandalone: uploadSpy } as unknown as ProductImagesService;
    action = new UploadCatalogCoverAction(dataSource, productImages);
  };

  beforeEach(() => {
    company = { id: '42', name: 'Esencia & Grano', catalog_cover_image: null } as Company;
    build();
  });

  it('sube la portada, guarda la ruta y devuelve la URL firmada', async () => {
    const result = await action.execute({ companyId: 42, file, actor });

    expect(uploadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 42, keyHint: 'catalog-cover', previousObject: null }),
    );
    expect(updatePatch).toEqual({ catalog_cover_image: 'inventory_items/42/catalog-cover-abc.png' });
    expect(result.cover_image_url).toBe('/product-images/serve?o=cover');
    expect(result.company.catalog_cover_image).toBe('inventory_items/42/catalog-cover-abc.png');
  });

  it('pasa la portada anterior para que el servicio la reemplace', async () => {
    company = {
      id: '42',
      name: 'Esencia & Grano',
      catalog_cover_image: 'inventory_items/42/catalog-cover-old.png',
    } as Company;
    build();

    await action.execute({ companyId: 42, file, actor });

    expect(uploadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ previousObject: 'inventory_items/42/catalog-cover-old.png' }),
    );
  });

  it('una company inexistente ⇒ NotFound (sin subir nada)', async () => {
    company = null;
    build();
    await expect(action.execute({ companyId: 42, file, actor })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});
