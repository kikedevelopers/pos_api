import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { GetItemsAction } from '@/modules/pos-data/actions/get-items.action';
import { FindAllProductsAction } from '@/modules/products/actions/find-all-products.action';
import { findProductInCompany } from '@/modules/products/internal/product-lookups';
import type { InventoryQueryDto } from '@/modules/products/dto/inventory-query.dto';

import {
  cleanupCompany,
  countRows,
  createDisposableCompany,
  E2E_TABLES,
  insertPackaging,
  insertPrice,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * FASE 0 — Tests de CARACTERIZACIÓN del comportamiento ACTUAL del scoping de
 * producto por company (multi-tenant). Red de seguridad ANTES de añadir
 * "compartir inventario entre companies".
 *
 * ⚠️ AISLAMIENTO CROSS-TENANT: los asserts marcados con el comentario
 *    `[[AISLAMIENTO-CROSS-TENANT — COMPARTIR CAMBIARÁ ESTO]]`
 *    codifican el comportamiento HOY (un producto de A NO es visible/usable
 *    desde B). La feature de sucursales "compartir inventario" RELAJARÁ
 *    deliberadamente estos asserts para productos compartidos. Cuando eso pase,
 *    estos casos DEBEN actualizarse de forma consciente, no romperse por
 *    sorpresa.
 *
 * NO toca companies reales. Company desechable `__E2E_SCOPE_A__` y
 * `__E2E_SCOPE_B__`, borradas con todo su rastro en afterAll. Skip limpio si
 * no hay BD.
 */

const COMPANY_A = '__E2E_SCOPE_A__';
const COMPANY_B = '__E2E_SCOPE_B__';

const EMPTY_QUERY = {} as InventoryQueryDto;

describe('Products scoping per-company (e2e, pos_db) — FASE 0 caracterización', () => {
  let ds: DataSource | null = null;
  let companyA = 0;
  let companyB = 0;
  let findAll: FindAllProductsAction;
  let getItems: GetItemsAction;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — products-scoping e2e SKIPPED.');
      return;
    }
    companyA = await createDisposableCompany(ds, COMPANY_A);
    companyB = await createDisposableCompany(ds, COMPANY_B);
    findAll = new FindAllProductsAction(ds);
    getItems = new GetItemsAction(ds);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    await cleanupCompany(ds, companyA);
    await cleanupCompany(ds, companyB);
    await ds.destroy();
  });

  it('findProductInCompany: encuentra en su company; NotFound desde otra company', async () => {
    if (!ds) {
      return;
    }
    const idA = await insertProduct(ds, companyA, { name: 'Producto A', cost: 10, stock: 5 });

    // Encuentra dentro de su propia company.
    const found = await findProductInCompany(ds.manager, Number(idA), companyA);
    expect(found.id).toBe(idA);
    expect(found.company_id).toBe(String(companyA));

    // [[AISLAMIENTO-CROSS-TENANT — COMPARTIR CAMBIARÁ ESTO]]
    // Hoy: el mismo producto NO es accesible desde otra company → NotFound.
    // Con "compartir inventario", un producto compartido SÍ será resoluble
    // desde la company receptora; este assert deberá relajarse para ese caso.
    await expect(findProductInCompany(ds.manager, Number(idA), companyB)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('índice único de sku es per-company: mismo sku en A y B coexiste; duplicar en A choca (23505)', async () => {
    if (!ds) {
      return;
    }
    const sku = 'SKU-SHARED-CODE';

    // Mismo sku en A y en B → AMBOS permitidos (el UNIQUE es parcial por company).
    const idA = await insertProduct(ds, companyA, { name: 'SkuTest A', cost: 1, skuCode: sku });
    const idB = await insertProduct(ds, companyB, { name: 'SkuTest B', cost: 1, skuCode: sku });
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    // NOTA: esto NO es aislamiento que "compartir" cambie — es independencia de
    // espacios de nombres entre tenants. Se documenta como baseline pero NO se
    // marca como cross-tenant-a-relajar.

    // Duplicar el sku DENTRO de A (ambos activos) → viola el índice único parcial.
    await expect(
      insertProduct(ds, companyA, { name: 'SkuTest A dup', cost: 1, skuCode: sku }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('FindAllProductsAction: A ve solo lo de A; B no ve lo de A', async () => {
    if (!ds) {
      return;
    }
    const idA = await insertProduct(ds, companyA, { name: 'Catalogo Solo A', cost: 3, stock: 1 });

    const listA = await findAll.execute(companyA, EMPTY_QUERY);
    const idsA = listA.map((p) => String(p.id));
    expect(idsA).toContain(String(idA));

    // [[AISLAMIENTO-CROSS-TENANT — COMPARTIR CAMBIARÁ ESTO]]
    // Hoy: el catálogo de B NO incluye productos de A. Con "compartir
    // inventario", el listado de B podría incluir productos compartidos de A.
    const listB = await findAll.execute(companyB, EMPTY_QUERY);
    const idsB = listB.map((p) => String(p.id));
    expect(idsB).not.toContain(String(idA));
  });

  it('GetItemsAction (POS): A ve solo lo de A; B no ve lo de A', async () => {
    if (!ds) {
      return;
    }
    const pkgA = await insertPackaging(ds, companyA, 'Caja POS A', 1);
    const idA = await insertProduct(ds, companyA, {
      name: 'POS Solo A',
      cost: 2,
      stock: 10,
      packagingId: pkgA,
    });
    // GetItems solo expone productos con al menos un precio y show_in_pos.
    await insertPrice(ds, companyA, idA, 5, 3, 60);

    const posA = await getItems.execute(companyA);
    const posIdsA = posA.map((it) => String(it.id));
    expect(posIdsA).toContain(String(idA));

    // [[AISLAMIENTO-CROSS-TENANT — COMPARTIR CAMBIARÁ ESTO]]
    // Hoy: el POS de B NO ve productos de A. "Compartir" hará que productos
    // compartidos de A aparezcan en el POS de B.
    const posB = await getItems.execute(companyB);
    const posIdsB = posB.map((it) => String(it.id));
    expect(posIdsB).not.toContain(String(idA));
  });

  it('cleanup deja ambas companies sin rastro', async () => {
    if (!ds) {
      return;
    }
    await cleanupCompany(ds, companyA);
    await cleanupCompany(ds, companyB);
    for (const table of E2E_TABLES) {
      expect(await countRows(ds, table, companyA)).toBe(0);
      expect(await countRows(ds, table, companyB)).toBe(0);
    }
    // Recreamos para que el afterAll re-limpie sin fallo.
    companyA = await createDisposableCompany(ds, COMPANY_A);
    companyB = await createDisposableCompany(ds, COMPANY_B);
  });
});
