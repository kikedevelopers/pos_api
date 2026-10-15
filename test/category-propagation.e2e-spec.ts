import type { DataSource } from 'typeorm';

import { GetPublicCatalogAction } from '@/modules/catalog/actions/get-public-catalog.action';
import { UpdateCategoryAction } from '@/modules/categories/actions/update-category.action';
import type { ProductImagesService } from '@/modules/product-images/product-images.service';
import { UpdateProductAction } from '@/modules/products/actions/update-product.action';

import {
  cleanupCompany,
  createDisposableCompany,
  E2E_ACTOR,
  insertCategory,
  insertPackaging,
  insertPrice,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E con BD REAL (pos_db):
 *
 *   1. La CATEGORÍA de un producto BASE se propaga a TODAS sus presentaciones
 *      al editar el base (antes había que re-guardar cada presentación).
 *   2. Una categoría oculta (`catalog_visible=false`) excluye a todos sus
 *      productos del catálogo público.
 *
 * Sin BD el describe se SKIPea. Companies desechables borradas en afterAll.
 */

const COMPANY_NAME = '__E2E_CATPROP__';
const COMPANY_NAME_B = '__E2E_CATPROP2__';
const SLUG = 'e2ecatprop';

describe('Categoría: propagación base → presentaciones y visibilidad en catálogo (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;
  let updateProduct: UpdateProductAction;
  let updateCategory: UpdateCategoryAction;
  let catalog: GetPublicCatalogAction;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — category-propagation e2e SKIPPED.');
      return;
    }
    for (const name of [COMPANY_NAME, COMPANY_NAME_B]) {
      const leftover = await ds.query(`SELECT id FROM companies WHERE name = $1`, [name]);
      for (const row of leftover) await cleanupCompany(ds, parseInt(row.id, 10));
    }
    companyId = await createDisposableCompany(ds, COMPANY_NAME);
    updateProduct = new UpdateProductAction(ds);
    updateCategory = new UpdateCategoryAction(ds);
    const productImages = {
      resolveUrls: () => Promise.resolve(new Map<string, string>()),
    } as unknown as ProductImagesService;
    catalog = new GetPublicCatalogAction(ds, productImages);
  });

  afterAll(async () => {
    if (!ds) return;
    await cleanupCompany(ds, companyId);
    const leftover = await ds.query(`SELECT id FROM companies WHERE name = $1`, [COMPANY_NAME_B]);
    for (const row of leftover) await cleanupCompany(ds, parseInt(row.id, 10));
    await ds.destroy();
  });

  async function categoryOf(cid: number, productId: string): Promise<number | null> {
    const r = await ds!.query(`SELECT category_id FROM products WHERE id = $1 AND company_id = $2`, [
      productId,
      String(cid),
    ]);
    return r[0]?.category_id != null ? Number(r[0].category_id) : null;
  }

  async function makeFamily(prefix: string, categoryId: string | null) {
    const pkgParent = await insertPackaging(ds!, companyId, `${prefix} caja`, 100);
    const pkgChild = await insertPackaging(ds!, companyId, `${prefix} media`, 50);
    const parentId = await insertProduct(ds!, companyId, {
      name: `${prefix} base`,
      cost: 1000,
      packagingId: pkgParent,
      categoryId,
    });
    const childA = await insertProduct(ds!, companyId, {
      name: `${prefix} hijo A`,
      cost: 500,
      packagingId: pkgChild,
      parentId,
      categoryId,
    });
    const childB = await insertProduct(ds!, companyId, {
      name: `${prefix} hijo B`,
      cost: 10,
      parentId,
      categoryId,
    });
    return { parentId, childA, childB };
  }

  it('cambiar la categoría del base la propaga a todas sus presentaciones', async () => {
    if (!ds) return;
    const catOld = await insertCategory(ds, companyId, 'Cat vieja');
    const catNew = await insertCategory(ds, companyId, 'Cat nueva');
    const { parentId, childA, childB } = await makeFamily('PROP', catOld);

    await updateProduct.execute(Number(parentId), { category_id: Number(catNew) }, companyId, E2E_ACTOR);

    expect(await categoryOf(companyId, parentId)).toBe(Number(catNew));
    expect(await categoryOf(companyId, childA)).toBe(Number(catNew));
    expect(await categoryOf(companyId, childB)).toBe(Number(catNew));
  });

  it('quitar la categoría del base (null) la quita también a sus presentaciones', async () => {
    if (!ds) return;
    const cat = await insertCategory(ds, companyId, 'Cat a quitar');
    const { parentId, childA } = await makeFamily('NULL', cat);

    await updateProduct.execute(Number(parentId), { category_id: null }, companyId, E2E_ACTOR);

    expect(await categoryOf(companyId, parentId)).toBeNull();
    expect(await categoryOf(companyId, childA)).toBeNull();
  });

  it('una presentación desalineada se realinea al cambiar la categoría del base', async () => {
    if (!ds) return;
    const catA = await insertCategory(ds, companyId, 'Desal A');
    const catB = await insertCategory(ds, companyId, 'Desal B');
    const catC = await insertCategory(ds, companyId, 'Desal C');
    const { parentId, childA } = await makeFamily('DESAL', catA);
    await ds.query(`UPDATE products SET category_id = $1 WHERE id = $2`, [catB, childA]);

    await updateProduct.execute(Number(parentId), { category_id: Number(catC) }, companyId, E2E_ACTOR);

    expect(await categoryOf(companyId, childA)).toBe(Number(catC));
  });

  it('editar el base SIN mandar category_id no toca la categoría de las presentaciones', async () => {
    if (!ds) return;
    const catA = await insertCategory(ds, companyId, 'Sin cambio A');
    const catB = await insertCategory(ds, companyId, 'Sin cambio B');
    const { parentId, childA } = await makeFamily('NOOP', catA);
    await ds.query(`UPDATE products SET category_id = $1 WHERE id = $2`, [catB, childA]);

    await updateProduct.execute(Number(parentId), { name: 'NOOP base renombrado' }, companyId, E2E_ACTOR);

    expect(await categoryOf(companyId, childA)).toBe(Number(catB));
  });

  it('cambiar la categoría de una PRESENTACIÓN no altera al base ni a sus hermanas', async () => {
    if (!ds) return;
    const catA = await insertCategory(ds, companyId, 'Hija A');
    const catB = await insertCategory(ds, companyId, 'Hija B');
    const { parentId, childA, childB } = await makeFamily('CHILD', catA);

    await updateProduct.execute(Number(childA), { category_id: Number(catB) }, companyId, E2E_ACTOR);

    expect(await categoryOf(companyId, parentId)).toBe(Number(catA));
    expect(await categoryOf(companyId, childB)).toBe(Number(catA));
  });

  it('multi-tenant: la propagación filtra company_id — hijo de otra company no se toca', async () => {
    if (!ds) return;
    const catA = await insertCategory(ds, companyId, 'MT A');
    const catNew = await insertCategory(ds, companyId, 'MT nueva');
    const { parentId } = await makeFamily('MT', catA);
    const companyB = await createDisposableCompany(ds, COMPANY_NAME_B);
    const catB = await insertCategory(ds, companyB, 'MT B');
    // Hijo en B colgado del padre de A (cross-tenant a propósito).
    const childOther = await insertProduct(ds, companyB, {
      name: 'MT B hijo',
      cost: 10,
      parentId,
      categoryId: catB,
    });

    await updateProduct.execute(Number(parentId), { category_id: Number(catNew) }, companyId, E2E_ACTOR);

    expect(await categoryOf(companyB, childOther)).toBe(Number(catB));
    await cleanupCompany(ds, companyB);
  });

  it('catálogo: ocultar una categoría excluye todos sus productos; mostrarla los devuelve', async () => {
    if (!ds) return;
    await ds.query(
      `UPDATE companies SET catalog_slug = $1, catalog_enabled = true WHERE id = $2`,
      [SLUG, String(companyId)],
    );
    const visible = await insertCategory(ds, companyId, 'Catálogo visible');
    const hidden = await insertCategory(ds, companyId, 'Catálogo oculta');
    const pVisible = await insertProduct(ds, companyId, { name: 'CAT prod visible', cost: 1, categoryId: visible });
    const pHidden = await insertProduct(ds, companyId, { name: 'CAT prod oculto', cost: 1, categoryId: hidden });
    const pNoCat = await insertProduct(ds, companyId, { name: 'CAT prod sin categoria', cost: 1 });
    for (const id of [pVisible, pHidden, pNoCat]) await insertPrice(ds, companyId, id, 1000, 0, 0);

    const ids = async () => (await catalog.execute(SLUG)).products.map((p) => p.id);

    expect(await ids()).toEqual(
      expect.arrayContaining([Number(pVisible), Number(pHidden), Number(pNoCat)]),
    );

    const updated = await updateCategory.execute(Number(hidden), { catalog_visible: false }, companyId);
    expect(updated.catalog_visible).toBe(false);

    const afterHide = await ids();
    expect(afterHide).not.toContain(Number(pHidden));
    expect(afterHide).toEqual(expect.arrayContaining([Number(pVisible), Number(pNoCat)]));

    await updateCategory.execute(Number(hidden), { catalog_visible: true }, companyId);
    expect(await ids()).toContain(Number(pHidden));
  });
});
