import Big from 'big.js';
import type { DataSource } from 'typeorm';

import { BulkProcessProductsAction } from '@/modules/products/actions/bulk-process-products.action';
import type { BulkItemDto } from '@/modules/products/dto/bulk-products.dto';

import { cleanupCompany, createDisposableCompany, E2E_ACTOR, tryInitDataSource } from './helpers/e2e-db';

/**
 * E2E (BD REAL pos_db) del soporte base/presentación en el import masivo.
 *
 * Verifica AL CENTAVO que una presentación importada quede IDÉNTICA a la del
 * formulario: costo DERIVADO del base (base_cost/base_pkg × pkg_presentación),
 * stock 0 (se deriva del padre), categoría HEREDADA, parent_id + packaging_id,
 * y precios con profit/margin recalculados contra el costo derivado. Empaque
 * find-or-create por nombre. Company desechable, sin tocar datos reales.
 */
const COMPANY_NAME = '__E2E_BULK_PRES__';
const round2 = (b: Big): number => b.round(2, Big.roundHalfUp).toNumber();

describe('Bulk import base/presentación (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;
  let action: BulkProcessProductsAction;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — bulk presentaciones SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, COMPANY_NAME);
    action = new BulkProcessProductsAction(ds);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    // Borrar hijos (presentaciones) antes que padres (parent_id RESTRICT).
    await ds.query(`DELETE FROM product_prices WHERE company_id = $1`, [String(companyId)]);
    await ds.query(`DELETE FROM inventory_movements WHERE company_id = $1`, [String(companyId)]);
    await ds.query(`DELETE FROM products WHERE company_id = $1 AND parent_id IS NOT NULL`, [
      String(companyId),
    ]);
    await ds.query(`DELETE FROM products WHERE company_id = $1`, [String(companyId)]);
    await ds.query(`DELETE FROM packagings WHERE company_id = $1`, [String(companyId)]);
    await cleanupCompany(ds, companyId);
    await ds.destroy();
  });

  async function bySku(sku: string): Promise<{
    id: string;
    parent_id: string | null;
    packaging_id: string | null;
    category_id: string | null;
    cost: number;
    stock: number;
  } | null> {
    const r = await ds!.query(
      `SELECT id, parent_id, packaging_id, category_id, cost::float AS cost, stock::float AS stock
       FROM products WHERE company_id = $1 AND sku_code = $2 AND is_archived = false`,
      [String(companyId), sku],
    );
    return r[0] ?? null;
  }
  async function pricesOf(productId: string): Promise<Array<{ sale: number; profit: number; margin: number }>> {
    return ds!.query(
      `SELECT sale_price::float AS sale, profit::float AS profit, margin::float AS margin
       FROM product_prices WHERE product_id = $1 AND company_id = $2 ORDER BY sale_price`,
      [productId, String(companyId)],
    );
  }
  async function packagingByName(name: string): Promise<{ id: string; value: number } | null> {
    const r = await ds!.query(
      `SELECT id, value::float AS value FROM packagings WHERE company_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND is_archived = false`,
      [String(companyId), name],
    );
    return r[0] ?? null;
  }

  it('crea BASE + 3 PRESENTACIONES en una carga: parent, empaque, categoría heredada, costo derivado, stock 0', async () => {
    if (!ds) {
      return;
    }
    // Presentaciones ANTES que el base en el arreglo → el orden bases-primero
    // debe procesarlas después igual.
    const items: BulkItemDto[] = [
      {
        name: 'Linaza 1/2 libra',
        sku_code: 'PRE-HALF',
        base_name: 'Linaza x libra',
        packaging: { name: 'MEDIA LIBRA', value: 0.5 },
        stock: 999, // debe IGNORARSE (presentación no guarda stock)
        cost: 999, // debe IGNORARSE (se deriva)
        prices: [{ sale_price: 3000 }],
      },
      {
        name: 'Linaza x libra',
        sku_code: 'BASE-LIB',
        base_name: '', // BASE
        category: 'Granos',
        cost: 3705,
        stock: 10,
        prices: [{ sale_price: 6000 }],
      },
      {
        name: 'Linaza x kilo',
        sku_code: 'PRE-KILO',
        base_name: 'Linaza x libra',
        packaging: { name: 'KILO', value: 2 },
        prices: [{ sale_price: 12000 }],
      },
      {
        name: 'Linaza x cuarto',
        sku_code: 'PRE-QTR',
        base_name: '  Linaza x libra  ', // espacios → trim, match igual
        packaging: { name: 'CUARTO LIBRA', value: 0.25 },
        prices: [{ sale_price: 1800 }],
      },
    ];

    const res = await action.execute(items, companyId, E2E_ACTOR);
    expect(res.conflicts).toEqual([]);
    expect(res.created).toBe(4);

    const base = await bySku('BASE-LIB');
    expect(base).not.toBeNull();
    expect(base!.parent_id).toBeNull();
    expect(base!.cost).toBe(3705);
    expect(base!.stock).toBe(10); // base sin empaque → mínima = paquetes
    const baseCategory = base!.category_id;
    expect(baseCategory).not.toBeNull();

    // Media libra: costo = 3705 × 0.5 = 1852.5; stock 0; categoría heredada.
    const half = await bySku('PRE-HALF');
    expect(half!.parent_id).toBe(base!.id);
    expect(half!.cost).toBe(1852.5);
    expect(half!.stock).toBe(0);
    expect(half!.category_id).toBe(baseCategory);
    const halfPkg = await packagingByName('MEDIA LIBRA');
    expect(halfPkg).not.toBeNull();
    expect(half!.packaging_id).toBe(halfPkg!.id);
    expect(halfPkg!.value).toBe(0.5);
    // Precio: profit/margin contra el costo DERIVADO (1852.5), no el del Excel.
    const halfPrices = await pricesOf(half!.id);
    expect(halfPrices).toHaveLength(1);
    expect(halfPrices[0].profit).toBe(round2(new Big(3000).minus(1852.5)));

    // Kilo: costo = 3705 × 2 = 7410.
    const kilo = await bySku('PRE-KILO');
    expect(kilo!.parent_id).toBe(base!.id);
    expect(kilo!.cost).toBe(7410);
    expect(kilo!.stock).toBe(0);

    // Cuarto: costo = 3705 × 0.25 = 926.25; el base matcheó pese a los espacios.
    const qtr = await bySku('PRE-QTR');
    expect(qtr!.parent_id).toBe(base!.id);
    expect(qtr!.cost).toBe(926.25);
  });

  it('EMPAQUE find-or-create: reutiliza el mismo packaging_id por nombre; valida value existente', async () => {
    if (!ds) {
      return;
    }
    // "MEDIA LIBRA" ya fue creado en el test anterior. Una nueva presentación
    // con el mismo nombre de empaque debe REUTILIZAR el packaging (mismo id).
    const existingPkg = await packagingByName('MEDIA LIBRA');
    expect(existingPkg).not.toBeNull();

    const res = await action.execute(
      [
        {
          name: 'Linaza premium 1/2',
          sku_code: 'PRE-HALF-2',
          base_name: 'Linaza x libra',
          packaging: { name: 'media libra', value: 0.5 }, // distinto case → mismo empaque
          prices: [{ sale_price: 3200 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.conflicts).toEqual([]);
    const p = await bySku('PRE-HALF-2');
    expect(p!.packaging_id).toBe(existingPkg!.id); // reutilizado, no duplicado
  });

  it('presentación con base INEXISTENTE → conflict (no crea nada)', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(
      [
        {
          name: 'Huérfana',
          sku_code: 'PRE-ORPHAN',
          base_name: 'Producto que no existe',
          packaging: { name: 'UNIDAD', value: 1 },
          prices: [{ sale_price: 100 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.created).toBe(0);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].reason).toMatch(/base .* no encontrado/i);
    expect(await bySku('PRE-ORPHAN')).toBeNull();
  });

  it('presentación SIN empaque → conflict (empaque obligatorio)', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(
      [
        {
          name: 'Sin empaque',
          sku_code: 'PRE-NOPKG',
          base_name: 'Linaza x libra',
          prices: [{ sale_price: 100 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].reason).toMatch(/empaque/i);
  });

  it('EDITAR: convertir un producto existente en presentación y luego devolverlo a base', async () => {
    if (!ds) {
      return;
    }
    // Crear un producto plano (base).
    await action.execute(
      [{ name: 'Convertible', sku_code: 'CONV-1', base_name: '', cost: 1000, stock: 5, prices: [{ sale_price: 2000 }] }],
      companyId,
      E2E_ACTOR,
    );
    const flat = await bySku('CONV-1');
    expect(flat!.parent_id).toBeNull();

    // Convertirlo en PRESENTACIÓN del base "Linaza x libra" (costo 3705, factor 2).
    await action.execute(
      [
        {
          name: 'Convertible',
          sku_code: 'CONV-1',
          base_name: 'Linaza x libra',
          packaging: { name: 'DOBLE', value: 2 },
          prices: [{ sale_price: 9000 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    const asPres = await bySku('CONV-1');
    const baseRow = await bySku('BASE-LIB');
    expect(asPres!.parent_id).toBe(baseRow!.id);
    expect(asPres!.cost).toBe(7410); // 3705 × 2
    expect(asPres!.stock).toBe(0);
    expect(asPres!.category_id).toBe(baseRow!.category_id); // heredada

    // Devolverlo a BASE (columna Base vacía → parent NULL). Empaque UNIDAD (value 1)
    // explícito → 8 paquetes = 8 en unidad mínima (sin arrastrar el factor de la
    // presentación anterior).
    await action.execute(
      [
        {
          name: 'Convertible',
          sku_code: 'CONV-1',
          base_name: '',
          packaging: { name: 'UNIDAD', value: 1 },
          cost: 1500,
          stock: 8,
          prices: [{ sale_price: 3000 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    const asBase = await bySku('CONV-1');
    expect(asBase!.parent_id).toBeNull();
    expect(asBase!.cost).toBe(1500);
    expect(asBase!.stock).toBe(8);
  });

  it('BASE con empaque: stock en paquetes se convierte a unidad mínima (× value)', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(
      [
        {
          name: 'Café por kilo',
          sku_code: 'BASE-KG',
          base_name: '',
          packaging: { name: 'BULTO', value: 50 },
          cost: 20000,
          stock: 3, // 3 bultos → 150 unidad mínima
          prices: [{ sale_price: 30000 }],
        },
      ],
      companyId,
      E2E_ACTOR,
    );
    expect(res.conflicts).toEqual([]);
    const base = await bySku('BASE-KG');
    expect(base!.parent_id).toBeNull();
    expect(base!.stock).toBe(150); // 3 × 50
    const pkg = await packagingByName('BULTO');
    expect(base!.packaging_id).toBe(pkg!.id);
  });

  it('sin columna Base (base_name undefined): preserva la jerarquía existente', async () => {
    if (!ds) {
      return;
    }
    // CONV-1 quedó como BASE. Un re-import SIN base_name no debe tocar parent_id.
    const before = await bySku('CONV-1');
    await action.execute(
      [{ name: 'Convertible', sku_code: 'CONV-1', cost: 1500, stock: 8, prices: [{ sale_price: 3000 }] }],
      companyId,
      E2E_ACTOR,
    );
    const after = await bySku('CONV-1');
    expect(after!.parent_id).toBe(before!.parent_id); // preservado
  });
});
