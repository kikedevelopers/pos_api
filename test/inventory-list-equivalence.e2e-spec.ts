import type { DataSource } from 'typeorm';

import { buildFindAllProductsSql } from '@/modules/products/actions/find-all-products.action';
import type { InventoryQueryDto } from '@/modules/products/dto/inventory-query.dto';
import { accessibleProductsPredicate } from '@/modules/products/internal/accessible-products.helper';

import {
  cleanupCompany,
  createDisposableBranch,
  createDisposableCompany,
  insertCategory,
  insertPackaging,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL pos_db) — la consulta optimizada de `GET /inventory` devuelve
 * EXACTAMENTE lo mismo que la anterior.
 *
 * La consulta anterior queda CONGELADA aquí (`legacySql`) como referencia. Se
 * comparan las filas crudas (mismas columnas, mismos valores) para cada
 * company y variante de filtro. Si alguien cambia la consulta nueva y altera
 * un dato, este test lo detecta.
 *
 * Cubre a propósito cada regla que tocó la optimización:
 *   - prefiltro por companies candidatas (propio, share company-level,
 *     share product-level, hijo de un padre compartido y un share
 *     product-level INCONSISTENTE: su `source` no es el dueño del producto);
 *   - última compra: RECIBIDA más reciente, ignorando PENDING, borradas y
 *     compras de OTRA company que incluyan el producto;
 *   - precios en el orden de su id aunque se inserten desordenados;
 *   - archivados, búsqueda y empates de `created_at`.
 */

const NAMES = {
  main: '__E2E_INV_EQ_MAIN__',
  other: '__E2E_INV_EQ_OTHER__',
  branch: '__E2E_INV_EQ_BRANCH__',
  product_share: '__E2E_INV_EQ_PSHARE__',
  odd_share: '__E2E_INV_EQ_ODDSHARE__',
};

const canConnectPromise = tryInitDataSource();

/** La consulta de `GET /inventory` ANTES de la optimización (congelada). */
const legacySql = (
  companyId: number,
  query: InventoryQueryDto,
): { sql: string; params: unknown[] } => {
  const accessPred = accessibleProductsPredicate('p', companyId, 1);
  const params: unknown[] = [...accessPred.params];
  const where: string[] = [accessPred.sql];
  if (query.include_archived !== true) {
    where.push('p.is_archived = false');
  }
  if (query.search && query.search.trim().length > 0) {
    params.push(`%${query.search.trim().toLowerCase()}%`);
    const idx = `$${params.length}`;
    where.push(
      `(LOWER(p.name) LIKE ${idx} OR LOWER(p.sku_code) LIKE ${idx} OR LOWER(p.bar_code) LIKE ${idx})`,
    );
  }
  const sql = `
    SELECT
      p.id AS id, p.name AS name, p.description AS description,
      p.product_type AS product_type, p.parent_id AS parent_id,
      p.sku_code AS sku_code, p.bar_code AS bar_code,
      p.packaging_id AS packaging_id, p.category_id AS category_id,
      p.tax_rate_id AS tax_rate_id, p.cost AS cost, p.stock AS stock,
      p.is_purchasable AS is_purchasable, p.image AS image,
      p.show_in_pos AS show_in_pos, p.catalog_visible AS catalog_visible,
      p.catalog_out_of_stock AS catalog_out_of_stock, p.is_archived AS is_archived,
      p.created_by AS created_by, p.updated_by AS updated_by,
      p.created_at AS created_at, p.updated_at AS updated_at,
      p.company_id AS company_id, p.cloned_from_company_id AS cloned_from_company_id,
      (
        SELECT MAX(pur.received_at)
        FROM purchase_lines pl
        JOIN purchases pur ON pur.id = pl.purchase_id
        WHERE pl.product_id = p.id
          AND pur.company_id = p.company_id
          AND pur.is_deleted = false
          AND pur.status = 'RECEIVED'
      ) AS last_purchase_date,
      pk.id AS packaging__id, pk.name AS packaging__name,
      pk.value AS packaging__value, pk.is_auto AS packaging__is_auto,
      cat.id AS category__id, cat.name AS category__name,
      COALESCE(pr.prices, '[]'::jsonb) AS prices
    FROM products p
    LEFT JOIN packagings pk ON pk.id = p.packaging_id
    LEFT JOIN categories  cat ON cat.id = p.category_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', pp.id, 'name', pp.name, 'sale_price', pp.sale_price,
          'profit', pp.profit, 'margin', pp.margin,
          'iva_percentage', pp.iva_percentage, 'taxable_base', pp.taxable_base,
          'tax_amount', pp.tax_amount
        ) ORDER BY pp.id
      ) AS prices
      FROM product_prices pp
      WHERE pp.product_id = p.id
    ) pr ON TRUE
    WHERE ${where.join(' AND ')}
    ORDER BY p.created_at DESC
  `;
  return { sql, params };
};

type Row = Record<string, unknown> & { id: string; created_at: Date };

const byId = (rows: Row[]): Row[] => [...rows].sort((a, b) => Number(a.id) - Number(b.id));

const QUERIES: InventoryQueryDto[] = [{}, { include_archived: true }, { search: 'fecula' }];

describe('GET /inventory · consulta optimizada ≡ consulta anterior (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  const cids: Record<keyof typeof NAMES, number> = {
    main: 0,
    other: 0,
    branch: 0,
    product_share: 0,
    odd_share: 0,
  };
  const ids: Record<string, string> = {};

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    if (!ds) {
      throw new Error('Sin BD');
    }
    return ds.query(sql, params);
  };

  /** Corre ambas consultas sin JIT (el JIT no cambia resultados, solo el tiempo). */
  const both = async (
    companyId: number,
    query: InventoryQueryDto,
  ): Promise<{ legacy: Row[]; next: Row[] }> => {
    if (!ds) {
      throw new Error('Sin BD');
    }
    return ds.transaction(async (manager) => {
      await manager.query('SET LOCAL jit = off');
      const old = legacySql(companyId, query);
      const now = buildFindAllProductsSql(companyId, query);
      return {
        legacy: await manager.query<Row[]>(old.sql, old.params),
        next: await manager.query<Row[]>(now.sql, now.params),
      };
    });
  };

  const supplier = async (company: number): Promise<string> =>
    (
      await q<{ id: string }>(
        `INSERT INTO suppliers (company_id, legal_name) VALUES ($1, 'E2E') RETURNING id`,
        [String(company)],
      )
    )[0].id;

  const purchase = async (
    company: number,
    supplier_id: string,
    number: string,
    o: { status: 'RECEIVED' | 'PENDING'; received_at?: string; deleted?: boolean },
    product_ids: string[],
  ): Promise<void> => {
    const [row] = await q<{ id: string }>(
      `INSERT INTO purchases (company_id, purchase_number, supplier_id, supplier_name, status,
                              received_at, received_by, is_deleted)
       VALUES ($1, $2, $3, 'E2E', $4::purchase_status, $5::timestamptz, $6, $7) RETURNING id`,
      [
        String(company),
        number,
        supplier_id,
        o.status,
        o.received_at ?? null,
        o.status === 'RECEIVED' ? 'e2e' : null,
        o.deleted === true,
      ],
    );
    for (const product_id of product_ids) {
      await q(
        `INSERT INTO purchase_lines (company_id, purchase_id, product_id, supplier_id, name, packaging_qty)
         VALUES ($1, $2, $3, $4, 'x', 1)`,
        [String(company), row.id, product_id, supplier_id],
      );
    }
  };

  const price = (
    company: number,
    product_id: string,
    name: string,
    value: number,
  ): Promise<unknown> =>
    q(
      `INSERT INTO product_prices (company_id, product_id, name, sale_price, profit, margin, iva_percentage)
       VALUES ($1, $2, $3, $4, 1.5, 12.3456, 19)`,
      [String(company), product_id, name, value],
    );

  beforeAll(async () => {
    ds = await canConnectPromise;
    if (!ds) {
      return;
    }
    cids.main = await createDisposableCompany(ds, NAMES.main);
    cids.other = await createDisposableCompany(ds, NAMES.other);
    cids.branch = await createDisposableBranch(ds, NAMES.branch);
    cids.product_share = await createDisposableBranch(ds, NAMES.product_share);
    cids.odd_share = await createDisposableBranch(ds, NAMES.odd_share);
    const main = cids.main;

    const libra = await insertPackaging(ds, main, 'LIBRA E2E', 500);
    const category = await insertCategory(ds, main, 'GRANOS E2E');
    ids.base = await insertProduct(ds, main, {
      name: 'FECULA DE MAIZ X LIBRA',
      cost: 2200,
      stock: 10000,
      packagingId: libra,
      categoryId: category,
      skuCode: 'FEC-1',
    });
    ids.child = await insertProduct(ds, main, {
      name: 'FECULA DE MAIZ X MEDIA LIBRA',
      cost: 1100,
      parentId: ids.base,
    });
    ids.child_archived = await insertProduct(ds, main, {
      name: 'FECULA DE MAIZ X CUARTO',
      cost: 550,
      parentId: ids.base,
    });
    ids.archived = await insertProduct(ds, main, { name: 'AZUCAR VIEJA', cost: 10 });
    ids.no_prices = await insertProduct(ds, main, { name: 'PANELA SIN PRECIO', cost: 1500 });
    ids.tie_a = await insertProduct(ds, main, { name: 'EMPATE A', cost: 1 });
    ids.tie_b = await insertProduct(ds, main, { name: 'EMPATE B', cost: 1 });
    await q(`UPDATE products SET is_archived = true WHERE id = ANY($1::bigint[])`, [
      [ids.child_archived, ids.archived],
    ]);
    await q(
      `UPDATE products SET created_at = '2026-01-01T00:00:00Z' WHERE id = ANY($1::bigint[])`,
      [[ids.tie_a, ids.tie_b]],
    );
    // Precios insertados en desorden de nombre: el orden es por id.
    await price(main, ids.base, 'Mayorista', 4000);
    await price(main, ids.base, 'Base', 4500);
    await price(main, ids.base, 'Especial', 4321.5);
    await price(main, ids.child, 'Base', 2500);

    // Compras: gana la RECIBIDA más reciente; PENDING y borradas no cuentan.
    const supplier_main = await supplier(main);
    await purchase(
      main,
      supplier_main,
      'E2E-1',
      { status: 'RECEIVED', received_at: '2026-03-01T10:00:00Z' },
      [ids.base, ids.no_prices],
    );
    await purchase(
      main,
      supplier_main,
      'E2E-2',
      { status: 'RECEIVED', received_at: '2026-04-01T10:00:00Z' },
      [ids.base],
    );
    await purchase(main, supplier_main, 'E2E-3', { status: 'PENDING' }, [ids.no_prices, ids.tie_a]);
    await purchase(
      main,
      supplier_main,
      'E2E-4',
      { status: 'RECEIVED', received_at: '2026-09-01T10:00:00Z', deleted: true },
      [ids.no_prices],
    );

    // Otra company: su compra incluye el producto del principal → NO cuenta para él.
    ids.other_product = await insertProduct(ds, cids.other, { name: 'FECULA AJENA', cost: 1 });
    const supplier_other = await supplier(cids.other);
    await purchase(
      cids.other,
      supplier_other,
      'E2E-O1',
      { status: 'RECEIVED', received_at: '2026-10-01T10:00:00Z' },
      [ids.base, ids.other_product],
    );

    // Sucursal: catálogo completo compartido + un producto propio.
    await insertProduct(ds, cids.branch, { name: 'FECULA DE LA SUCURSAL', cost: 1 });
    await q(
      `INSERT INTO inventory_shares (source_company_id, target_company_id, product_id) VALUES ($1, $2, NULL)`,
      [String(main), String(cids.branch)],
    );
    // Share por producto (el padre → sus presentaciones también se ven).
    await q(
      `INSERT INTO inventory_shares (source_company_id, target_company_id, product_id) VALUES ($1, $2, $3)`,
      [String(main), String(cids.product_share), ids.base],
    );
    // Share por producto INCONSISTENTE: el source no es el dueño del producto.
    await q(
      `INSERT INTO inventory_shares (source_company_id, target_company_id, product_id) VALUES ($1, $2, $3)`,
      [String(cids.other), String(cids.odd_share), ids.no_prices],
    );
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    const all = Object.values(cids).map(String);
    await q(
      `DELETE FROM inventory_shares WHERE source_company_id = ANY($1::bigint[]) OR target_company_id = ANY($1::bigint[])`,
      [all],
    );
    await q(`DELETE FROM purchase_lines WHERE company_id = ANY($1::bigint[])`, [all]);
    await q(`DELETE FROM purchases WHERE company_id = ANY($1::bigint[])`, [all]);
    await q(`DELETE FROM suppliers WHERE company_id = ANY($1::bigint[])`, [all]);
    for (const company of [
      cids.branch,
      cids.product_share,
      cids.odd_share,
      cids.other,
      cids.main,
    ]) {
      await cleanupCompany(ds, company);
    }
    await ds.destroy();
  });

  const itDb = (name: string, fn: () => Promise<void>): void => {
    it(name, async () => {
      if (!(await canConnectPromise)) {
        return; // sin BD en el runner: se omite limpio.
      }
      await fn();
    });
  };

  for (const key of Object.keys(NAMES) as Array<keyof typeof NAMES>) {
    for (const query of QUERIES) {
      itDb(`${key} ${JSON.stringify(query)}: mismas filas y mismos valores`, async () => {
        const { legacy, next } = await both(cids[key], query);
        expect(byId(next)).toEqual(byId(legacy));
      });
    }
  }

  itDb('los fixtures ejercitan lo que deben (no es una comparación vacía)', async () => {
    const main = byId((await both(cids.main, { include_archived: true })).next);
    const row = (id: string): Row | undefined => main.find((r) => r.id === id);
    // Última compra = la RECIBIDA más reciente del principal (no la borrada ni la ajena).
    expect((row(ids.base)?.last_purchase_date as Date).toISOString()).toBe(
      '2026-04-01T10:00:00.000Z',
    );
    expect((row(ids.no_prices)?.last_purchase_date as Date).toISOString()).toBe(
      '2026-03-01T10:00:00.000Z',
    );
    expect(row(ids.tie_a)?.last_purchase_date).toBeNull();
    // Precios en orden de id.
    expect((row(ids.base)?.prices as Array<{ name: string }>).map((p) => p.name)).toEqual([
      'Mayorista',
      'Base',
      'Especial',
    ]);
    expect(row(ids.no_prices)?.prices).toEqual([]);

    const branch = (await both(cids.branch, {})).next.map((r) => r.name);
    expect(branch).toEqual(
      expect.arrayContaining(['FECULA DE MAIZ X LIBRA', 'FECULA DE LA SUCURSAL']),
    );
    const shared = (await both(cids.product_share, {})).next.map((r) => r.name).sort();
    expect(shared).toEqual(['FECULA DE MAIZ X LIBRA', 'FECULA DE MAIZ X MEDIA LIBRA']);
    const odd = (await both(cids.odd_share, {})).next.map((r) => r.name);
    expect(odd).toEqual(['PANELA SIN PRECIO']);
  });

  itDb('orden: created_at DESC y, en empates, por id DESC (determinista)', async () => {
    const rows = (await both(cids.main, {})).next;
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1];
      const curr = rows[i];
      const diff = prev.created_at.getTime() - curr.created_at.getTime();
      expect(diff > 0 || (diff === 0 && Number(prev.id) > Number(curr.id))).toBe(true);
    }
  });

  itDb('barrido: TODAS las companies de la BD devuelven lo mismo que antes', async () => {
    const companies = await q<{ id: string }>(`SELECT id FROM companies ORDER BY id`);
    let compared = 0;
    for (const { id } of companies) {
      for (const query of QUERIES) {
        const { legacy, next } = await both(Number(id), query);
        expect(byId(next)).toEqual(byId(legacy));
        compared += next.length;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
});
