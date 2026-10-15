import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { ProductImagesService } from '@/modules/product-images/product-images.service';

import { GetPublicCatalogAction } from '../actions/get-public-catalog.action';

/**
 * `GetPublicCatalogAction`: resuelve el negocio por slug SOLO si el catálogo
 * está publicado, y expone únicamente datos públicos (precios de venta, nunca
 * costo/ganancia/margen/stock).
 */
describe('GetPublicCatalogAction', () => {
  let action: GetPublicCatalogAction;
  let foundCompany: Record<string, unknown> | null;
  let rows: unknown[];
  let findOneSpy: jest.Mock;
  let querySpy: jest.Mock;
  let resolveSpy: jest.Mock;

  const build = (): void => {
    findOneSpy = jest.fn(() => Promise.resolve(foundCompany));
    querySpy = jest.fn(() => Promise.resolve(rows));
    resolveSpy = jest.fn(() => Promise.resolve(new Map([['inventory_items/13/5.jpg', '/product-images/serve?o=5']])));

    const dataSource = {
      manager: { findOne: findOneSpy },
      query: querySpy,
    } as unknown as DataSource;
    const productImages = { resolveUrls: resolveSpy } as unknown as ProductImagesService;
    action = new GetPublicCatalogAction(dataSource, productImages);
  };

  beforeEach(() => {
    foundCompany = {
      id: '13',
      name: 'Esencia & Grano',
      catalog_slug: 'esenciaygrano',
      catalog_group_by_category: false,
    };
    rows = [
      {
        id: '5',
        name: 'Café 500g',
        description: 'Tueste medio',
        category_name: 'Café',
        image_path: 'inventory_items/13/5.jpg',
        out_of_stock: false,
        prices: [
          { name: 'Detal', sale_price: '12000' },
          { name: 'Mayor', sale_price: '10000' },
        ],
      },
    ];
    build();
  });

  it('404 si el slug normaliza a vacío (sin golpear la BD)', async () => {
    await expect(action.execute('   ')).rejects.toBeInstanceOf(NotFoundException);
    expect(findOneSpy).not.toHaveBeenCalled();
  });

  it('resuelve la company por slug normalizado y catalog_enabled=true', async () => {
    await action.execute('Esencia Y Grano');
    const where = (findOneSpy.mock.calls[0][1] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ catalog_slug: 'esenciaygrano', catalog_enabled: true });
  });

  it('404 cuando no hay company publicada con ese slug', async () => {
    foundCompany = null;
    build();
    await expect(action.execute('inexistente')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('solo lista productos no archivados y visibles en POS, filtrados por company', async () => {
    await action.execute('esenciaygrano');
    const sql = String(querySpy.mock.calls[0][0]);
    expect(sql).toContain('p.company_id = $1');
    expect(sql).toContain('p.is_archived = false');
    expect(sql).toContain('p.show_in_pos = true');
    expect(sql).toContain('p.catalog_visible = true');
    expect((querySpy.mock.calls[0][1] as unknown[])[0]).toBe(13);
  });

  it('excluye los productos de categorías ocultas del catálogo (sin categoría = visible)', async () => {
    await action.execute('esenciaygrano');
    const sql = String(querySpy.mock.calls[0][0]);
    expect(sql).toContain('(cat.id IS NULL OR cat.catalog_visible = true)');
  });

  it('NO expone costo, ganancia ni margen en el SQL', async () => {
    await action.execute('esenciaygrano');
    const sql = String(querySpy.mock.calls[0][0]);
    expect(sql).not.toMatch(/\bp\.cost\b/);
    expect(sql).not.toMatch(/\bpp\.profit\b/);
    expect(sql).not.toMatch(/\bpp\.margin\b/);
  });

  it('mapea el producto con precios de venta e imagen firmada', async () => {
    const result = await action.execute('esenciaygrano');

    expect(result.business).toEqual({
      name: 'Esencia & Grano',
      slug: 'esenciaygrano',
      group_by_category: false,
      cover_image_url: null,
    });
    expect(result.count).toBe(1);
    const product = result.products[0];
    expect(product).toMatchObject({
      id: 5,
      name: 'Café 500g',
      description: 'Tueste medio',
      category: 'Café',
      image_url: '/product-images/serve?o=5',
      out_of_stock: false,
    });
    expect(product.prices).toEqual([
      { name: 'Detal', price: 12000 },
      { name: 'Mayor', price: 10000 },
    ]);
  });

  it('expone la URL firmada de la portada cuando el negocio tiene una', async () => {
    foundCompany = {
      id: '13',
      name: 'Esencia & Grano',
      catalog_slug: 'esenciaygrano',
      catalog_group_by_category: false,
      catalog_cover_image: 'inventory_items/13/catalog-cover-abc.jpg',
    };
    build();
    resolveSpy.mockResolvedValue(
      new Map([['inventory_items/13/catalog-cover-abc.jpg', '/product-images/serve?o=cover']]),
    );
    const result = await action.execute('esenciaygrano');
    expect(result.business.cover_image_url).toBe('/product-images/serve?o=cover');
  });

  it('cover_image_url es null cuando el negocio no subió portada', async () => {
    const result = await action.execute('esenciaygrano');
    expect(result.business.cover_image_url).toBeNull();
  });

  it('refleja la preferencia de agrupar por categoría del negocio', async () => {
    foundCompany = {
      id: '13',
      name: 'Esencia & Grano',
      catalog_slug: 'esenciaygrano',
      catalog_group_by_category: true,
    };
    build();
    const result = await action.execute('esenciaygrano');
    expect(result.business.group_by_category).toBe(true);
  });

  it('un producto sin imagen deja image_url en null', async () => {
    rows = [
      { id: '7', name: 'Sin foto', description: null, category_name: null, image_path: null, out_of_stock: false, prices: [] },
    ];
    build();
    const result = await action.execute('esenciaygrano');
    expect(result.products[0].image_url).toBeNull();
    expect(result.products[0].prices).toEqual([]);
  });

  it('expone out_of_stock cuando el producto está marcado fuera de stock', async () => {
    rows = [
      {
        id: '9',
        name: 'Agotado',
        description: null,
        category_name: null,
        image_path: null,
        out_of_stock: true,
        prices: [{ name: 'Base', sale_price: '5000' }],
      },
    ];
    build();
    const result = await action.execute('esenciaygrano');
    expect(result.products[0].out_of_stock).toBe(true);
  });
});
