import Big from 'big.js';
import type { DataSource } from 'typeorm';

import { BulkProcessProductsAction } from '@/modules/products/actions/bulk-process-products.action';
import { UpdateProductAction } from '@/modules/products/actions/update-product.action';
import type { UpdateProductDto } from '@/modules/products/dto/update-product.dto';

import {
  cleanupCompany,
  countRows,
  createDisposableCompany,
  E2E_ACTOR,
  E2E_TABLES,
  insertPackaging,
  insertPrice,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E con BD REAL (pos_db): propagación del costo de un producto PADRE a sus
 * presentaciones (hijos) cuando el cost se edita por FORM (UpdateProductAction)
 * o por EXCEL (BulkProcessProductsAction). Verifica cost del hijo
 * (= parentCostMin × child.pkg.value), profit/margin de sus precios, historial
 * (EDIT / PARENT / purchase_id null) y aislamiento multi-tenant.
 *
 * Patrón anti-CI-rojo: sin BD, el describe se SKIPea. Company desechable
 * `__E2E_PROP__` (+ una segunda `__E2E_PROP2__` para el caso multi-tenant),
 * borradas con todo su rastro en `afterAll`.
 */

const COMPANY_NAME = '__E2E_PROP__';
const COMPANY_NAME_B = '__E2E_PROP2__';

const round2 = (b: Big): number => b.round(2, Big.roundHalfUp).toNumber();
const round4 = (b: Big): number => b.round(4, Big.roundHalfUp).toNumber();

describe('Parent → children cost propagation (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;
  let formAction: UpdateProductAction;
  let bulkAction: BulkProcessProductsAction;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — parent-cost-propagation e2e SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, COMPANY_NAME);
    formAction = new UpdateProductAction(ds);
    bulkAction = new BulkProcessProductsAction(ds);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    await cleanupCompany(ds, companyId);
    // Por si el caso multi-tenant dejó la company B.
    const leftover = await ds.query(`SELECT id FROM companies WHERE name = $1`, [COMPANY_NAME_B]);
    for (const row of leftover) {
      await cleanupCompany(ds, parseInt(row.id, 10));
    }
    await ds.destroy();
  });

  // Lecturas ──────────────────────────────────────────────────────────────
  async function productRow(cid: number, id: string) {
    const r = await ds!.query(
      `SELECT id, cost::float AS cost, parent_id, packaging_id, name FROM products WHERE id = $1 AND company_id = $2`,
      [id, String(cid)],
    );
    return r[0];
  }
  async function pricesOf(cid: number, productId: string) {
    return ds!.query(
      `SELECT sale_price::float AS sale, profit::float AS profit, margin::float AS margin
       FROM product_prices WHERE product_id = $1 AND company_id = $2 ORDER BY sale_price`,
      [productId, String(cid)],
    );
  }
  async function costHistory(cid: number, productId: string) {
    return ds!.query(
      `SELECT id, event_type, derived_from, purchase_id, cost_before::float AS cb, cost_after::float AS ca
       FROM product_cost_history WHERE product_id = $1 AND company_id = $2 ORDER BY id`,
      [productId, String(cid)],
    );
  }
  async function priceHistory(cid: number, productId: string) {
    return ds!.query(
      `SELECT id, product_price_id, cost_history_id FROM product_price_history
       WHERE product_id = $1 AND company_id = $2 ORDER BY id`,
      [productId, String(cid)],
    );
  }

  /** Cada precio del hijo: profit = round2(sale - childCost), margin = round4((profit/sale)*100). */
  async function expectChildPricesRecomputed(cid: number, childId: string, childCost: number) {
    const prices = await pricesOf(cid, childId);
    for (const p of prices) {
      const expProfit = round2(new Big(p.sale).minus(childCost));
      const expMargin = p.sale > 0 ? round4(new Big(p.sale).minus(childCost).div(p.sale).times(100)) : 0;
      expect(p.profit).toBe(expProfit);
      expect(p.margin).toBe(expMargin);
    }
  }

  it('FORM: editar cost del padre propaga a hijos (cost + profit/margin + historial EDIT/PARENT)', async () => {
    if (!ds) return;
    const pkgParent = await insertPackaging(ds, companyId, 'Caja 1000', 1000);
    const pkg500 = await insertPackaging(ds, companyId, 'Media 500', 500);
    const pkg250 = await insertPackaging(ds, companyId, 'Cuarto 250', 250);
    const parentId = await insertProduct(ds, companyId, { name: 'Padre FORM', cost: 1000, stock: 50, packagingId: pkgParent });
    const childA = await insertProduct(ds, companyId, { name: 'Hijo A 500', cost: 500, packagingId: pkg500, parentId });
    const childB = await insertProduct(ds, companyId, { name: 'Hijo B 250', cost: 250, packagingId: pkg250, parentId });
    await insertPrice(ds, companyId, childA, 700, 200, round4(new Big(200).div(700).times(100)));
    await insertPrice(ds, companyId, childA, 800, 300, round4(new Big(300).div(800).times(100)));
    await insertPrice(ds, companyId, childB, 400, 150, round4(new Big(150).div(400).times(100)));

    await formAction.execute(Number(parentId), { cost: 1500 } as UpdateProductDto, companyId, E2E_ACTOR);

    const parentCostMin = new Big(1500).div(1000); // 1.5
    const expA = round2(parentCostMin.times(500)); // 750
    const expB = round2(parentCostMin.times(250)); // 375

    expect((await productRow(companyId, parentId)).cost).toBe(1500);
    expect((await productRow(companyId, childA)).cost).toBe(expA);
    expect((await productRow(companyId, childB)).cost).toBe(expB);
    await expectChildPricesRecomputed(companyId, childA, expA);
    await expectChildPricesRecomputed(companyId, childB, expB);

    for (const [cid, prices] of [[childA, 2], [childB, 1]] as const) {
      const hist = await costHistory(companyId, cid);
      expect(hist).toHaveLength(1);
      expect(hist[0].event_type).toBe('EDIT');
      expect(hist[0].derived_from).toBe('PARENT');
      expect(hist[0].purchase_id).toBeNull();
      const ph = await priceHistory(companyId, cid);
      expect(ph).toHaveLength(prices);
      expect(ph.every((r: { cost_history_id: string }) => r.cost_history_id === hist[0].id)).toBe(true);
    }
  });

  it('EXCEL: editar cost del padre vía bulk propaga a hijos', async () => {
    if (!ds) return;
    const pkgParent = await insertPackaging(ds, companyId, 'Caja Excel 1000', 1000);
    const pkg500 = await insertPackaging(ds, companyId, 'Media Excel 500', 500);
    const parentId = await insertProduct(ds, companyId, {
      name: 'Padre EXCEL', cost: 1000, stock: 20, packagingId: pkgParent, skuCode: 'PADRE-EXCEL',
    });
    const childA = await insertProduct(ds, companyId, { name: 'Hijo Excel 500', cost: 500, packagingId: pkg500, parentId });
    await insertPrice(ds, companyId, childA, 900, 400, round4(new Big(400).div(900).times(100)));

    const res = await bulkAction.execute(
      [{ name: 'Padre EXCEL', sku_code: 'PADRE-EXCEL', cost: 2000, prices: [{ sale_price: 5000 }] } as never],
      companyId,
      E2E_ACTOR,
    );
    expect(res.updated).toBe(1);

    const expChild = round2(new Big(2000).div(1000).times(500)); // 1000
    expect((await productRow(companyId, childA)).cost).toBe(expChild);
    await expectChildPricesRecomputed(companyId, childA, expChild);

    const hist = await costHistory(companyId, childA);
    expect(hist).toHaveLength(1);
    expect(hist[0].event_type).toBe('EDIT');
    expect(hist[0].derived_from).toBe('PARENT');
    expect(hist[0].purchase_id).toBeNull();
  });

  it('NO-OP: editar padre con el MISMO cost → hijos sin cambios ni historial', async () => {
    if (!ds) return;
    const pkgParent = await insertPackaging(ds, companyId, 'Caja NoOp 1000', 1000);
    const pkg500 = await insertPackaging(ds, companyId, 'Media NoOp 500', 500);
    const parentId = await insertProduct(ds, companyId, { name: 'Padre NOOP', cost: 1000, stock: 10, packagingId: pkgParent });
    const childA = await insertProduct(ds, companyId, { name: 'Hijo NoOp 500', cost: 500, packagingId: pkg500, parentId });
    await insertPrice(ds, companyId, childA, 700, 200, round4(new Big(200).div(700).times(100)));

    await formAction.execute(Number(parentId), { cost: 1000 } as UpdateProductDto, companyId, E2E_ACTOR);

    expect((await productRow(companyId, childA)).cost).toBe(500);
    expect(await costHistory(companyId, childA)).toHaveLength(0);
    expect(await priceHistory(companyId, childA)).toHaveLength(0);
  });

  it('editar HIJO directo (parent_id != null) → no propaga, sin filas PARENT', async () => {
    if (!ds) return;
    const pkgParent = await insertPackaging(ds, companyId, 'Caja H 1000', 1000);
    const pkg500 = await insertPackaging(ds, companyId, 'Media H 500', 500);
    const parentId = await insertProduct(ds, companyId, { name: 'Padre H', cost: 1000, stock: 5, packagingId: pkgParent });
    const childA = await insertProduct(ds, companyId, { name: 'Hijo H 500', cost: 500, packagingId: pkg500, parentId });
    await insertPrice(ds, companyId, childA, 700, 200, round4(new Big(200).div(700).times(100)));

    await formAction.execute(Number(childA), { cost: 600 } as UpdateProductDto, companyId, E2E_ACTOR);

    expect((await productRow(companyId, childA)).cost).toBe(600);
    const hist = await costHistory(companyId, childA);
    expect(hist.filter((h: { derived_from: string }) => h.derived_from === 'PARENT')).toHaveLength(0);
    expect((await productRow(companyId, parentId)).cost).toBe(1000);
  });

  it('padre SIN hijos → editar cost OK, sin historial PARENT', async () => {
    if (!ds) return;
    const pkgParent = await insertPackaging(ds, companyId, 'Caja Solo 1000', 1000);
    const parentId = await insertProduct(ds, companyId, { name: 'Padre SOLO', cost: 1000, stock: 5, packagingId: pkgParent });

    await expect(
      formAction.execute(Number(parentId), { cost: 1234 } as UpdateProductDto, companyId, E2E_ACTOR),
    ).resolves.toBeDefined();

    expect((await productRow(companyId, parentId)).cost).toBe(1234);
    const hist = await costHistory(companyId, parentId);
    expect(hist.filter((h: { derived_from: string }) => h.derived_from === 'PARENT')).toHaveLength(0);
  });

  it('hijo SIN packaging → se omite (no crashea); resto de hijos sí se actualiza', async () => {
    if (!ds) return;
    const pkgParent = await insertPackaging(ds, companyId, 'Caja Skip 1000', 1000);
    const pkg500 = await insertPackaging(ds, companyId, 'Media Skip 500', 500);
    const parentId = await insertProduct(ds, companyId, { name: 'Padre SKIP', cost: 1000, stock: 5, packagingId: pkgParent });
    const childWith = await insertProduct(ds, companyId, { name: 'Hijo CON pkg', cost: 500, packagingId: pkg500, parentId });
    const childNo = await insertProduct(ds, companyId, { name: 'Hijo SIN pkg', cost: 300, packagingId: null, parentId });
    await insertPrice(ds, companyId, childWith, 700, 200, round4(new Big(200).div(700).times(100)));
    await insertPrice(ds, companyId, childNo, 400, 100, round4(new Big(100).div(400).times(100)));

    await expect(
      formAction.execute(Number(parentId), { cost: 1500 } as UpdateProductDto, companyId, E2E_ACTOR),
    ).resolves.toBeDefined();

    const expWith = round2(new Big(1500).div(1000).times(500)); // 750
    expect((await productRow(companyId, childWith)).cost).toBe(expWith);
    expect((await productRow(companyId, childNo)).cost).toBe(300); // intacto
    expect(await costHistory(companyId, childNo)).toHaveLength(0);
    expect(await costHistory(companyId, childWith)).toHaveLength(1);
  });

  it('precisión Big.js: cost padre 1333 (pkg 1000) → hijo 500 = 666.5', async () => {
    if (!ds) return;
    const pkgParent = await insertPackaging(ds, companyId, 'Caja Prec 1000', 1000);
    const pkg500 = await insertPackaging(ds, companyId, 'Media Prec 500', 500);
    const parentId = await insertProduct(ds, companyId, { name: 'Padre PREC', cost: 1000, stock: 5, packagingId: pkgParent });
    const childA = await insertProduct(ds, companyId, { name: 'Hijo Prec 500', cost: 500, packagingId: pkg500, parentId });
    await insertPrice(ds, companyId, childA, 999, 499, round4(new Big(499).div(999).times(100)));

    await formAction.execute(Number(parentId), { cost: 1333 } as UpdateProductDto, companyId, E2E_ACTOR);

    expect((await productRow(companyId, childA)).cost).toBe(666.5);
    await expectChildPricesRecomputed(companyId, childA, 666.5);

    // Control: volver a 1000 → hijo 500 exacto.
    await formAction.execute(Number(parentId), { cost: 1000 } as UpdateProductDto, companyId, E2E_ACTOR);
    expect((await productRow(companyId, childA)).cost).toBe(500);
  });

  it('multi-tenant: la propagación filtra company_id — hijo de otra company no se toca', async () => {
    if (!ds) return;
    const pkgParentA = await insertPackaging(ds, companyId, 'Caja MT A 1000', 1000);
    const pkg500A = await insertPackaging(ds, companyId, 'Media MT A 500', 500);
    const parentA = await insertProduct(ds, companyId, { name: 'Padre MT A', cost: 1000, stock: 5, packagingId: pkgParentA });
    const childA = await insertProduct(ds, companyId, { name: 'Hijo MT A', cost: 500, packagingId: pkg500A, parentId: parentA });
    await insertPrice(ds, companyId, childA, 700, 200, round4(new Big(200).div(700).times(100)));

    const companyB = await createDisposableCompany(ds, COMPANY_NAME_B);
    const pkg500B = await insertPackaging(ds, companyB, 'Media MT B 500', 500);
    // Hijo en B con parent_id = id del padre de A (cross-tenant a propósito).
    const childB = await insertProduct(ds, companyB, { name: 'Hijo MT B', cost: 999, packagingId: pkg500B, parentId: parentA });
    const childBCostBefore = (await productRow(companyB, childB)).cost;

    await formAction.execute(Number(parentA), { cost: 1500 } as UpdateProductDto, companyId, E2E_ACTOR);

    const expA = round2(new Big(1500).div(1000).times(500)); // 750
    expect((await productRow(companyId, childA)).cost).toBe(expA);
    expect((await productRow(companyB, childB)).cost).toBe(childBCostBefore); // intacto
    expect(await costHistory(companyB, childB)).toHaveLength(0);

    await cleanupCompany(ds, companyB);
  });

  it('cleanup deja la company sin rastro', async () => {
    if (!ds) return;
    await cleanupCompany(ds, companyId);
    for (const table of E2E_TABLES) {
      expect(await countRows(ds, table, companyId)).toBe(0);
    }
    companyId = await createDisposableCompany(ds, COMPANY_NAME);
  });
});
