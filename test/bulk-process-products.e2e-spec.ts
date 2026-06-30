import Big from 'big.js';
import type { DataSource } from 'typeorm';

import { BulkProcessProductsAction } from '@/modules/products/actions/bulk-process-products.action';

import {
  cleanupCompany,
  countRows,
  createDisposableCompany,
  E2E_ACTOR,
  E2E_TABLES,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E con BD REAL (pos_db) de `BulkProcessProductsAction` (`POST /inventory/bulk`).
 *
 * Patrón anti-CI-rojo: si no hay BD disponible, `beforeAll` no consigue
 * conexión y el describe entero se SKIPea (no rompe `npm run test:e2e` en un
 * runner sin Postgres). Con BD disponible corre de verdad.
 *
 * Company desechable `__E2E_BULK__`, borrada con todo su rastro en `afterAll`.
 * NUNCA toca companies reales.
 */

const COMPANY_NAME = '__E2E_BULK__';

const round2 = (b: Big): number => b.round(2, Big.roundHalfUp).toNumber();
const round4 = (b: Big): number => b.round(4, Big.roundHalfUp).toNumber();

describe('BulkProcessProductsAction (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;
  let action: BulkProcessProductsAction;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // Sin BD: los tests se marcan skipped vía el guard `if (!ds) return;`.
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — BulkProcessProductsAction e2e SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, COMPANY_NAME);
    action = new BulkProcessProductsAction(ds);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    await cleanupCompany(ds, companyId);
    await ds.destroy();
  });

  // Helpers de lectura ──────────────────────────────────────────────────────
  async function getBySku(sku: string) {
    return ds!.query(
      `SELECT p.*, pp.sale_price::float AS pp_sale, pp.profit::float AS pp_profit, pp.margin::float AS pp_margin
       FROM products p
       LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.company_id = p.company_id
       WHERE p.company_id = $1 AND p.sku_code = $2 AND p.is_archived = false`,
      [String(companyId), sku],
    );
  }
  async function pricesOf(productId: string) {
    return ds!.query(
      `SELECT sale_price::float AS sale, profit::float AS profit, margin::float AS margin
       FROM product_prices WHERE product_id = $1 AND company_id = $2 ORDER BY sale_price`,
      [productId, String(companyId)],
    );
  }
  async function categoryCount(): Promise<number> {
    const r = await ds!.query(`SELECT COUNT(*) AS n FROM categories WHERE company_id = $1`, [
      String(companyId),
    ]);
    return parseInt(r[0].n, 10);
  }
  async function movementsCount(productId?: string): Promise<number> {
    if (productId) {
      const r = await ds!.query(
        `SELECT COUNT(*) AS n FROM inventory_movements WHERE company_id = $1 AND product_id = $2`,
        [String(companyId), productId],
      );
      return parseInt(r[0].n, 10);
    }
    const r = await ds!.query(
      `SELECT COUNT(*) AS n FROM inventory_movements WHERE company_id = $1`,
      [String(companyId)],
    );
    return parseInt(r[0].n, 10);
  }

  it('CREATE válido con código → created=1, precio con profit/margin Big.js, categoría creada', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(
      [
        {
          name: 'Coca-Cola 2L',
          sku_code: 'SKU-001',
          bar_code: 'BAR-001',
          category: 'Bebidas',
          description: 'Botella retornable de 2 litros',
          stock: 10,
          cost: 2.5,
          prices: [{ sale_price: 5.0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.created).toBe(1);
    expect(res.conflicts).toHaveLength(0);

    const rows = await getBySku('SKU-001');
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('Botella retornable de 2 litros');
    expect(parseFloat(rows[0].stock)).toBe(10);
    expect(rows[0].show_in_pos).toBe(true);
    expect(rows[0].is_purchasable).toBe(false);
    expect(rows[0].pp_profit).toBe(round2(new Big(5).minus(2.5)));
    expect(rows[0].pp_margin).toBe(round4(new Big(2.5).div(5).times(100)));
    expect(await categoryCount()).toBe(1);
    expect(await movementsCount()).toBe(0);
  });

  it('re-import idéntico → skipped, sin nuevos movimientos', async () => {
    if (!ds) {
      return;
    }
    const movBefore = await movementsCount();
    const res = await action.execute(
      [
        {
          name: 'Coca-Cola 2L',
          sku_code: 'SKU-001',
          bar_code: 'BAR-001',
          category: 'Bebidas',
          description: 'Botella retornable de 2 litros',
          stock: 10,
          cost: 2.5,
          prices: [{ sale_price: 5.0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.skipped).toBe(1);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(0);
    expect(await movementsCount()).toBe(movBefore);
  });

  it('UPDATE (cost/precio/stock/description) → updated=1, inventory_movement por delta', async () => {
    if (!ds) {
      return;
    }
    const before = await getBySku('SKU-001');
    const productId = before[0].id as string;
    const stockBefore = parseFloat(before[0].stock);

    const res = await action.execute(
      [
        {
          name: 'Coca-Cola 2L',
          sku_code: 'SKU-001',
          bar_code: 'BAR-001',
          category: 'Bebidas',
          description: 'Descripción actualizada',
          stock: 25,
          cost: 3.0,
          prices: [{ sale_price: 6.5 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.updated).toBe(1);

    const after = await getBySku('SKU-001');
    expect(parseFloat(after[0].cost)).toBe(3.0);
    expect(after[0].description).toBe('Descripción actualizada');
    expect(parseFloat(after[0].stock)).toBe(25);

    const prices = await pricesOf(productId);
    expect(prices).toHaveLength(1);
    expect(prices[0].profit).toBe(round2(new Big(6.5).minus(3)));
    expect(prices[0].margin).toBe(round4(new Big(3.5).div(6.5).times(100)));

    const movs = await ds.query(
      `SELECT direction, quantity::float AS q, stock_before::float AS sb, stock_after::float AS sa, reason
       FROM inventory_movements WHERE company_id = $1 AND product_id = $2 ORDER BY created_at`,
      [String(companyId), productId],
    );
    expect(movs).toHaveLength(1);
    expect(movs[0].direction).toBe('IN');
    expect(movs[0].q).toBe(15);
    expect(movs[0].sb).toBe(stockBefore);
    expect(movs[0].sa).toBe(25);
    expect(movs[0].reason).toBe('BULK_IMPORT');
  });

  it('UPDATE preserve-on-empty: description/category/flags/stock + sku/bar omitidos preservan → skipped', async () => {
    if (!ds) {
      return;
    }
    const before = await getBySku('SKU-001');
    const movBefore = await movementsCount();

    // Enviamos ambos códigos (para que el match no cambie nada) y description ''
    // (preservar). category/show_in_pos/is_purchasable/stock undefined → preservar.
    const res = await action.execute(
      [
        {
          name: 'Coca-Cola 2L',
          sku_code: 'SKU-001',
          bar_code: 'BAR-001',
          description: '',
          cost: 3.0,
          prices: [{ sale_price: 6.5 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.skipped).toBe(1);

    const after = await getBySku('SKU-001');
    expect(after[0].description).toBe(before[0].description);
    expect(after[0].category_id).toBe(before[0].category_id);
    expect(after[0].show_in_pos).toBe(before[0].show_in_pos);
    expect(after[0].is_purchasable).toBe(before[0].is_purchasable);
    expect(parseFloat(after[0].stock)).toBe(parseFloat(before[0].stock));
    expect(await movementsCount()).toBe(movBefore);
  });

  it('preserve-on-empty de códigos: sku presente, bar omitido + cost distinto → bar_code se conserva', async () => {
    if (!ds) {
      return;
    }
    await action.execute(
      [
        {
          name: 'Fix Producto A',
          sku_code: 'A',
          bar_code: '123',
          cost: 1.0,
          prices: [{ sale_price: 5.0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    const res = await action.execute(
      [
        {
          name: 'Fix Producto A',
          sku_code: 'A',
          cost: 2.0,
          prices: [{ sale_price: 5.0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.updated).toBe(1);
    const after = await getBySku('A');
    expect(after[0].bar_code).toBe('123');
    expect(parseFloat(after[0].cost)).toBe(2.0);
  });

  it('preserve-on-empty de códigos: match por bar, sku omitido → sku_code se conserva', async () => {
    if (!ds) {
      return;
    }
    // Producto sku=A bar=123 ya existe (cost=2.0). Match por bar, sku omitido.
    const res = await action.execute(
      [
        {
          name: 'Fix Producto A',
          bar_code: '123',
          cost: 3.0,
          prices: [{ sale_price: 5.0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.updated).toBe(1);
    const after = await ds.query(
      `SELECT sku_code, bar_code, cost::float FROM products WHERE company_id = $1 AND bar_code = '123' AND is_archived = false`,
      [String(companyId)],
    );
    expect(after[0].sku_code).toBe('A');
    expect(parseFloat(after[0].cost)).toBe(3.0);
  });

  it('mismo sku en batch (idéntico) → created=1 + skipped=1, sin duplicado', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(
      [
        {
          name: 'Doble',
          sku_code: 'SKU-DOBLE',
          cost: 1.0,
          prices: [{ sale_price: 3.0 }],
        },
        {
          name: 'Doble',
          sku_code: 'SKU-DOBLE',
          cost: 1.0,
          prices: [{ sale_price: 3.0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    const rows = await ds.query(
      `SELECT COUNT(*) AS n FROM products WHERE company_id = $1 AND sku_code = 'SKU-DOBLE' AND is_archived = false`,
      [String(companyId)],
    );
    expect(parseInt(rows[0].n, 10)).toBe(1);
  });

  it('mismo sku en batch con datos distintos → created=1 + updated=1, estado=segundo', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(
      [
        {
          name: 'Seq',
          sku_code: 'SKU-SEQ',
          cost: 1.0,
          prices: [{ sale_price: 4.0 }],
        },
        {
          name: 'Seq',
          sku_code: 'SKU-SEQ',
          cost: 2.0,
          prices: [{ sale_price: 8.0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.created).toBe(1);
    expect(res.updated).toBe(1);
    const rows = await getBySku('SKU-SEQ');
    expect(parseFloat(rows[0].cost)).toBe(2.0);
    expect(rows[0].pp_sale).toBe(8.0);
  });

  it('nombre duplicado sin código → conflict; el batch no aborta', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(
      [
        { name: 'Sin Codigo Dup', cost: 1.0, prices: [{ sale_price: 2.0 }] },
        { name: 'Sin Codigo Dup', cost: 1.5, prices: [{ sale_price: 3.0 }] },
        {
          name: 'Valido Tres',
          sku_code: 'SKU-TRES',
          cost: 1.0,
          prices: [{ sale_price: 5.0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.created).toBe(2);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].reason).toContain('nombre');
    expect(await getBySku('SKU-TRES')).toHaveLength(1);
  });

  it('precio negativo / 0 / sin precios en CREATE → conflict "No tiene precios válidos."', async () => {
    if (!ds) {
      return;
    }
    const resNeg = await action.execute(
      [
        {
          name: 'Neg',
          sku_code: 'SKU-NEG',
          cost: 1.0,
          prices: [{ sale_price: -5.0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(resNeg.created).toBe(0);
    expect(resNeg.conflicts[0]?.reason).toBe('No tiene precios válidos.');

    const resCero = await action.execute(
      [
        {
          name: 'Cero',
          sku_code: 'SKU-CERO',
          cost: 1.0,
          prices: [{ sale_price: 0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(resCero.conflicts[0]?.reason).toBe('No tiene precios válidos.');

    const resSin = await action.execute(
      [{ name: 'SinPrecios', sku_code: 'SKU-SINP', cost: 1.0, prices: [] }],
      companyId,
      E2E_ACTOR,
    );
    expect(resSin.conflicts[0]?.reason).toBe('No tiene precios válidos.');
  });

  it('nombre vacío → conflict "Nombre vacío."', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(
      [
        {
          name: '   ',
          sku_code: 'SKU-NV',
          cost: 1.0,
          prices: [{ sale_price: 5.0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.conflicts[0]?.reason).toBe('Nombre vacío.');
  });

  it('categoría accent-insensitive: "Bebidas"≡"BÉBIDAS"≢"bebida"', async () => {
    if (!ds) {
      return;
    }
    const catBefore = await categoryCount();
    const res = await action.execute(
      [
        {
          name: 'Agua 1L',
          sku_code: 'SKU-AGUA',
          category: 'BÉBIDAS',
          cost: 0.5,
          prices: [{ sale_price: 1.5 }],
        },
        {
          name: 'Jugo',
          sku_code: 'SKU-JUGO',
          category: 'bebida',
          cost: 1.0,
          prices: [{ sale_price: 3.0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.created).toBe(2);
    // "BÉBIDAS" reutiliza "Bebidas"; "bebida" es categoría nueva → +1.
    expect(await categoryCount()).toBe(catBefore + 1);

    const agua = await getBySku('SKU-AGUA');
    const cola = await getBySku('SKU-001');
    const jugo = await getBySku('SKU-JUGO');
    expect(agua[0].category_id).toBe(cola[0].category_id);
    expect(jugo[0].category_id).not.toBe(cola[0].category_id);
  });

  it('batch mixto [válido, nombre-vacío, válido, precio-0] → created=2, conflicts=2', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(
      [
        {
          name: 'Mixto A',
          sku_code: 'SKU-MIXA',
          cost: 1.0,
          prices: [{ sale_price: 3.0 }],
        },
        { name: '', sku_code: 'SKU-MIXB', cost: 1.0, prices: [{ sale_price: 3.0 }] },
        {
          name: 'Mixto C',
          sku_code: 'SKU-MIXC',
          cost: 1.0,
          prices: [{ sale_price: 4.0 }],
        },
        {
          name: 'Mixto D',
          sku_code: 'SKU-MIXD',
          cost: 1.0,
          prices: [{ sale_price: 0 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.created).toBe(2);
    expect(res.conflicts).toHaveLength(2);
    const reasons = res.conflicts.map((c) => c.reason);
    expect(reasons).toContain('Nombre vacío.');
    expect(reasons).toContain('No tiene precios válidos.');
  });

  it('cleanup deja la company sin rastro', async () => {
    if (!ds) {
      return;
    }
    await cleanupCompany(ds, companyId);
    for (const table of E2E_TABLES) {
      expect(await countRows(ds, table, companyId)).toBe(0);
    }
    // Recreamos la company para que el afterAll no falle al re-limpiar.
    companyId = await createDisposableCompany(ds, COMPANY_NAME);
  });
});
