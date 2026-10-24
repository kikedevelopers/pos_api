import type { DataSource, Repository } from 'typeorm';

import { FindLastPurchaseCostsAction } from '@/modules/purchases/actions/find-last-purchase-costs.action';
import type { PurchaseLine } from '@/modules/purchases/entities/purchase-line.entity';

import {
  cleanupCompany,
  createDisposableCompany,
  insertPackaging,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E con BD REAL (pos_db): `GET /purchases/last-costs` devuelve el costo
 * BRUTO de la última compra de cada producto (lo que facturó el proveedor),
 * NUNCA `products.cost`, que trae el flete prorrateado. Bug de origen: el
 * configurador de compras sugería 1.010 (1.000 + 10 de flete) y la compra
 * nueva quedaba inflada.
 *
 * Patrón anti-CI-rojo: sin BD, el describe se SKIPea. Companies desechables
 * borradas con todo su rastro en `afterAll`.
 */

const COMPANY_NAME = '__E2E_LAST_COST__';
const COMPANY_NAME_B = '__E2E_LAST_COST_B__';

describe('Last purchase gross costs (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;
  let companyB = 0;
  let action: FindLastPurchaseCostsAction;
  let purchaseSeq = 0;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — last-purchase-costs e2e SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, COMPANY_NAME);
    companyB = await createDisposableCompany(ds, COMPANY_NAME_B);
    action = new FindLastPurchaseCostsAction({
      manager: ds.manager,
    } as unknown as Repository<PurchaseLine>);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    for (const cid of [companyId, companyB]) {
      await ds.query(`DELETE FROM purchase_lines WHERE company_id = $1`, [String(cid)]);
      await ds.query(`DELETE FROM purchases WHERE company_id = $1`, [String(cid)]);
      await ds.query(`DELETE FROM suppliers WHERE company_id = $1`, [String(cid)]);
      await cleanupCompany(ds, cid);
    }
    await ds.destroy();
  });

  // Fixtures ──────────────────────────────────────────────────────────────
  async function insertSupplier(cid: number): Promise<string> {
    const r = await ds!.query(
      `INSERT INTO suppliers (company_id, legal_name) VALUES ($1, 'E2E') RETURNING id`,
      [String(cid)],
    );
    return r[0].id;
  }

  interface LineFixture {
    productId: string;
    packagingPrice: number;
    packagingValue: number | null;
    unitPrice: number;
  }

  async function insertPurchase(
    cid: number,
    supplierId: string,
    o: {
      createdAt: string;
      status?: 'PENDING' | 'RECEIVED';
      deleted?: boolean;
    },
    lines: LineFixture[],
  ): Promise<string> {
    purchaseSeq += 1;
    const status = o.status ?? 'RECEIVED';
    const [row] = await ds!.query(
      `INSERT INTO purchases (company_id, purchase_number, supplier_id, supplier_name, status,
                              received_at, received_by, is_deleted, created_at)
       VALUES ($1, $2, $3, 'E2E', $4::purchase_status, $5::timestamptz, $6, $7, $8::timestamptz)
       RETURNING id`,
      [
        String(cid),
        `E2E-LC-${purchaseSeq}`,
        supplierId,
        status,
        status === 'RECEIVED' ? o.createdAt : null,
        status === 'RECEIVED' ? 'e2e' : null,
        o.deleted === true,
        o.createdAt,
      ],
    );
    for (const l of lines) {
      await ds!.query(
        `INSERT INTO purchase_lines (company_id, purchase_id, product_id, supplier_id, name,
                                     packaging_qty, packaging_price, packaging_value, unit_price,
                                     unit_qty, subtotal, total)
         VALUES ($1, $2, $3, $4, 'x', 1, $5, $6, $7, $8, $5, $5)`,
        [
          String(cid),
          row.id,
          l.productId,
          supplierId,
          l.packagingPrice,
          l.packagingValue,
          l.unitPrice,
          l.packagingValue ?? 1,
        ],
      );
    }
    return row.id;
  }

  async function costOf(cid: number, productId: string) {
    const all = await action.execute(cid);
    return all.find((r) => r.product_id === Number(productId));
  }

  // Casos ─────────────────────────────────────────────────────────────────
  it('devuelve el costo BRUTO de la línea, no products.cost con flete', async () => {
    if (!ds) {
      return;
    }
    const pkg = await insertPackaging(ds, companyId, 'Kilo', 1000);
    // products.cost ya inflado por el flete prorrateado (1.000 + 10); la
    // compra (con su transportista) se simula solo con su línea bruta.
    const productId = await insertProduct(ds, companyId, {
      name: 'Clavo',
      cost: 1010,
      packagingId: pkg,
    });
    const supplierId = await insertSupplier(companyId);
    const purchaseId = await insertPurchase(
      companyId,
      supplierId,
      { createdAt: '2026-10-01T10:00:00Z' },
      [{ productId, packagingPrice: 1000, packagingValue: 1000, unitPrice: 1 }],
    );

    const row = await costOf(companyId, productId);
    expect(row).toEqual({
      product_id: Number(productId),
      purchase_id: Number(purchaseId),
      packaging_price: 1000,
      packaging_value: 1000,
      unit_price: 1,
      purchase_created_at: '2026-10-01T10:00:00.000Z',
    });
  });

  it('toma la compra MÁS RECIENTE, aunque sea PENDING', async () => {
    if (!ds) {
      return;
    }
    const productId = await insertProduct(ds, companyId, { name: 'Canela', cost: 999 });
    const supplierId = await insertSupplier(companyId);
    await insertPurchase(companyId, supplierId, { createdAt: '2026-09-01T10:00:00Z' }, [
      { productId, packagingPrice: 500, packagingValue: null, unitPrice: 500 },
    ]);
    await insertPurchase(
      companyId,
      supplierId,
      { createdAt: '2026-10-10T10:00:00Z', status: 'PENDING' },
      [{ productId, packagingPrice: 650, packagingValue: null, unitPrice: 650 }],
    );
    // Más vieja insertada al final: el orden es por fecha, no por id.
    await insertPurchase(companyId, supplierId, { createdAt: '2026-08-01T10:00:00Z' }, [
      { productId, packagingPrice: 400, packagingValue: null, unitPrice: 400 },
    ]);

    const row = await costOf(companyId, productId);
    expect(row?.packaging_price).toBe(650);
    expect(row?.packaging_value).toBeNull();
  });

  it('ignora compras eliminadas', async () => {
    if (!ds) {
      return;
    }
    const productId = await insertProduct(ds, companyId, { name: 'Pistacho', cost: 1 });
    const supplierId = await insertSupplier(companyId);
    await insertPurchase(companyId, supplierId, { createdAt: '2026-09-01T10:00:00Z' }, [
      { productId, packagingPrice: 700, packagingValue: null, unitPrice: 700 },
    ]);
    await insertPurchase(
      companyId,
      supplierId,
      { createdAt: '2026-10-01T10:00:00Z', deleted: true },
      [{ productId, packagingPrice: 900, packagingValue: null, unitPrice: 900 }],
    );

    expect((await costOf(companyId, productId))?.packaging_price).toBe(700);
  });

  it('ignora líneas con costo 0 (bonificaciones)', async () => {
    if (!ds) {
      return;
    }
    const productId = await insertProduct(ds, companyId, { name: 'Almendra', cost: 1 });
    const supplierId = await insertSupplier(companyId);
    await insertPurchase(companyId, supplierId, { createdAt: '2026-09-01T10:00:00Z' }, [
      { productId, packagingPrice: 800, packagingValue: null, unitPrice: 800 },
    ]);
    await insertPurchase(companyId, supplierId, { createdAt: '2026-10-01T10:00:00Z' }, [
      { productId, packagingPrice: 0, packagingValue: null, unitPrice: 0 },
    ]);

    expect((await costOf(companyId, productId))?.packaging_price).toBe(800);
  });

  it('producto repetido en la misma compra: gana la última línea', async () => {
    if (!ds) {
      return;
    }
    const productId = await insertProduct(ds, companyId, { name: 'Uva pasa', cost: 1 });
    const supplierId = await insertSupplier(companyId);
    await insertPurchase(companyId, supplierId, { createdAt: '2026-10-01T10:00:00Z' }, [
      { productId, packagingPrice: 100, packagingValue: null, unitPrice: 100 },
      { productId, packagingPrice: 120, packagingValue: null, unitPrice: 120 },
    ]);

    expect((await costOf(companyId, productId))?.packaging_price).toBe(120);
  });

  it('producto sin compras no aparece', async () => {
    if (!ds) {
      return;
    }
    const productId = await insertProduct(ds, companyId, { name: 'Nuevo', cost: 5000 });
    expect(await costOf(companyId, productId)).toBeUndefined();
  });

  it('aislamiento multi-tenant: no ve compras de otra company', async () => {
    if (!ds) {
      return;
    }
    const productB = await insertProduct(ds, companyB, { name: 'Ajeno', cost: 1 });
    const supplierB = await insertSupplier(companyB);
    await insertPurchase(companyB, supplierB, { createdAt: '2026-10-01T10:00:00Z' }, [
      { productId: productB, packagingPrice: 333, packagingValue: null, unitPrice: 333 },
    ]);

    const fromA = await action.execute(companyId);
    expect(fromA.some((r) => r.product_id === Number(productB))).toBe(false);
    expect((await costOf(companyB, productB))?.packaging_price).toBe(333);
  });
});
