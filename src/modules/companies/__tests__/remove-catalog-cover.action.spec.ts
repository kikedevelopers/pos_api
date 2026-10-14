import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { ProductImagesService } from '@/modules/product-images/product-images.service';

import { RemoveCatalogCoverAction } from '../actions/remove-catalog-cover.action';
import type { Company } from '../entities/company.entity';

/**
 * `RemoveCatalogCoverAction`: limpia la columna y borra el objeto del bucket.
 * Idempotente cuando no hay portada.
 */
describe('RemoveCatalogCoverAction', () => {
  let action: RemoveCatalogCoverAction;
  let company: Company | null;
  let updateSpy: jest.Mock;
  let removeImagesSpy: jest.Mock;

  const build = (): void => {
    updateSpy = jest.fn((_e: unknown, _w: unknown, patch: Partial<Company>) => {
      if (company) Object.assign(company, patch);
      return Promise.resolve({ affected: 1 });
    });
    const manager = {
      findOne: jest.fn(() => Promise.resolve(company)),
      update: updateSpy,
      findOneOrFail: jest.fn(() => Promise.resolve(company)),
    };
    const dataSource = { manager } as unknown as DataSource;
    removeImagesSpy = jest.fn(() => Promise.resolve(1));
    const productImages = { removeImages: removeImagesSpy } as unknown as ProductImagesService;
    action = new RemoveCatalogCoverAction(dataSource, productImages);
  };

  beforeEach(() => {
    company = {
      id: '42',
      name: 'Esencia & Grano',
      catalog_cover_image: 'inventory_items/42/catalog-cover-abc.png',
    } as Company;
    build();
  });

  it('borra la portada del bucket y pone la columna en null', async () => {
    const result = await action.execute(42);

    expect(removeImagesSpy).toHaveBeenCalledWith(['inventory_items/42/catalog-cover-abc.png'], 42);
    expect(updateSpy).toHaveBeenCalledWith(expect.anything(), { id: '42' }, { catalog_cover_image: null });
    expect(result.catalog_cover_image).toBeNull();
  });

  it('idempotente: sin portada no toca el bucket ni la BD', async () => {
    company = { id: '42', name: 'Esencia & Grano', catalog_cover_image: null } as Company;
    build();

    const result = await action.execute(42);

    expect(removeImagesSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.catalog_cover_image).toBeNull();
  });

  it('una company inexistente ⇒ NotFound', async () => {
    company = null;
    build();
    await expect(action.execute(42)).rejects.toBeInstanceOf(NotFoundException);
  });
});
