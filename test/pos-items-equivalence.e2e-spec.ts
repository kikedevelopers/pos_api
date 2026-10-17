import type { DataSource } from 'typeorm';

import {
  buildPosItemsSql,
  GetItemsAction,
  type PosItem,
} from '@/modules/pos-data/actions/get-items.action';
import { accessibleProductsPredicate } from '@/modules/products/internal/accessible-products.helper';

import {
  cleanupCompany,
  createDisposableBranch,
  createDisposableCompany,
  insertPackaging,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL pos_db) — la consulta optimizada de `GET /pos-data/items`
 * produce EXACTAMENTE los mismos items que la anterior.
 *
 * La consulta anterior queda CONGELADA aquí. Se compara la SALIDA COMPLETA de
 * `GetItemsAction` (con su post-proceso: padres ocultos con presentaciones
 * visibles, stock derivado del padre, combos, imagen vinculada), alimentándola
 * con las filas de cada consulta:
 *
 *   - contra la consulta vieja TAL CUAL → mismos items (como conjunto: la vieja
 *     no tenía ORDER BY y los empates de `created_at` dependían del plan);
 *   - contra la vieja con el mismo desempate `ORDER BY p.id` → mismo ORDEN.
 */

const NAMES = {
  main: '__E2E_POS_EQ_MAIN__',
  branch: '__E2E_POS_EQ_BRANCH__',
  product_share: '__E2E_POS_EQ_PSHARE__',
  odd_share: '__E2E_POS_EQ_ODDSHARE__',
  other: '__E2E_POS_EQ_OTHER__',
};

const canConnectPromise = tryInitDataSource();

/** La consulta de `GET /pos-data/items` ANTES de la optimización (congelada). */
const legacySql = (companyId: number, order_by_id = false): { sql: string; params: unknown[] } => {
  const accessPred = accessibleProductsPredicate('p', companyId, 1);
  const sql = `
    SELECT
      p.id AS id, p.name AS name, p.cost AS cost, p.bar_code AS bar_code,
      p.sku_code AS sku_code, p.parent_id AS parent_id, p.packaging_id AS packaging_id,
      p.product_type AS product_type, p.show_in_pos AS show_in_pos,
      p.created_at AS created_at, p.stock AS stock, p.company_id AS company_id,
      p.image AS image, p.use_parent_image AS use_parent_image,
      p.description AS description,
      pk.id AS packaging__id, pk.name AS packaging__name,
      pk.value AS packaging__value, pk.is_auto AS packaging__is_auto,
      COALESCE(pr.prices, '[]'::jsonb) AS prices
    FROM products p
    LEFT JOIN packagings pk ON pk.id = p.packaging_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', pp.id, 'sale_price', pp.sale_price, 'profit', pp.profit, 'margin', pp.margin
        ) ORDER BY pp.id
      ) AS prices
      FROM product_prices pp
      WHERE pp.product_id = p.id
    ) pr ON TRUE
    WHERE ${accessPred.sql} AND p.is_archived = false
    ${order_by_id ? 'ORDER BY p.id' : ''}
  `;
  return { sql, params: [...accessPred.params] };
};

describe('GET /pos-data/items · consulta optimizada ≡ consulta anterior (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  const cids: Record<keyof typeof NAMES, number> = {
    main: 0,
    branch: 0,
    product_share: 0,
    odd_share: 0,
    other: 0,
  };
  const ids: Record<string, string> = {};

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    if (!ds) {
      throw new Error('Sin BD');
    }
    return ds.query(sql, params);
  };

  /**
   * Corre `GetItemsAction` con las filas de una consulta dada (`override`) o
   * con la suya propia. Mismo post-proceso en ambos casos.
   */
  const run = (
    companyId: number,
    override?: { sql: string; params: unknown[] },
  ): Promise<PosItem[]> => {
    const db = ds as DataSource;
    const proxy = {
      manager: db.manager,
      transaction: <T>(work: (manager: { query: DataSource['query'] }) => Promise<T>) =>
        db.transaction((manager) =>
          work({
            query: ((sql: string, params?: unknown[]) =>
              override && !/SET LOCAL/.test(sql)
                ? manager.query(override.sql, override.params)
                : manager.query(sql, params)) as DataSource['query'],
          }),
        ),
    } as unknown as DataSource;
    return new GetItemsAction(proxy).execute(companyId);
  };

  const byId = (items: PosItem[]): PosItem[] => [...items].sort((a, b) => a.id - b.id);

  const price = (company: number, product_id: string, value: number): Promise<unknown> =>
    q(
      `INSERT INTO product_prices (company_id, product_id, name, sale_price, profit, margin, iva_percentage)
       VALUES ($1, $2, 'Base', $3, 1.25, 33.3333, 0)`,
      [String(company), product_id, value],
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

    const libra = await insertPackaging(ds, main, 'LIBRA POS E2E', 500);
    const media = await insertPackaging(ds, main, 'MEDIA POS E2E', 250);
    ids.base = await insertProduct(ds, main, {
      name: 'FECULA BASE',
      cost: 2200,
      stock: 10000,
      packagingId: libra,
      skuCode: 'POS-1',
    });
    ids.child = await insertProduct(ds, main, {
      name: 'FECULA MEDIA',
      cost: 1100,
      parentId: ids.base,
      packagingId: media,
    });
    // Padre OCULTO del POS con una presentación visible: se muestra la hija.
    ids.hidden_base = await insertProduct(ds, main, {
      name: 'ARROZ BASE OCULTO',
      cost: 1,
      stock: 3000,
      packagingId: libra,
      showInPos: false,
    });
    ids.hidden_child = await insertProduct(ds, main, {
      name: 'ARROZ MEDIA',
      cost: 1,
      parentId: ids.hidden_base,
      packagingId: media,
    });
    ids.archived = await insertProduct(ds, main, { name: 'ARCHIVADO', cost: 1 });
    ids.tie_a = await insertProduct(ds, main, { name: 'EMPATE A', cost: 1 });
    ids.tie_b = await insertProduct(ds, main, { name: 'EMPATE B', cost: 1 });
    await q(`UPDATE products SET is_archived = true WHERE id = $1`, [ids.archived]);
    await q(
      `UPDATE products SET created_at = '2026-01-01T00:00:00Z' WHERE id = ANY($1::bigint[])`,
      [[ids.tie_a, ids.tie_b]],
    );
    await q(`UPDATE products SET image = 'x/base.png' WHERE id = $1`, [ids.base]);
    await q(`UPDATE products SET use_parent_image = true WHERE id = $1`, [ids.child]);
    await price(main, ids.base, 4500);
    await price(main, ids.base, 4000);
    await price(main, ids.child, 2500);

    await insertProduct(ds, cids.branch, { name: 'PROPIO SUCURSAL', cost: 1 });
    await insertProduct(ds, cids.other, { name: 'AJENO', cost: 1 });
    await q(
      `INSERT INTO inventory_shares (source_company_id, target_company_id, product_id) VALUES ($1, $2, NULL)`,
      [String(main), String(cids.branch)],
    );
    await q(
      `INSERT INTO inventory_shares (source_company_id, target_company_id, product_id) VALUES ($1, $2, $3)`,
      [String(main), String(cids.product_share), ids.base],
    );
    // Share por producto INCONSISTENTE: el source no es el dueño del producto.
    await q(
      `INSERT INTO inventory_shares (source_company_id, target_company_id, product_id) VALUES ($1, $2, $3)`,
      [String(cids.other), String(cids.odd_share), ids.tie_a],
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
    itDb(`${key}: mismos items, y mismo orden con el mismo desempate`, async () => {
      const next = await run(cids[key]);
      expect(byId(next)).toEqual(byId(await run(cids[key], legacySql(cids[key]))));
      expect(next).toEqual(await run(cids[key], legacySql(cids[key], true)));
    });
  }

  itDb('los fixtures ejercitan lo que deben (no es una comparación vacía)', async () => {
    const items = await run(cids.main);
    const names = items.map((item) => item.name);
    // Padre oculto: no aparece, pero su presentación visible sí.
    expect(names).not.toContain('ARROZ BASE OCULTO');
    expect(names).toContain('ARROZ MEDIA');
    expect(names).not.toContain('ARCHIVADO');
    const base = items.find((item) => item.name === 'FECULA BASE');
    const child = items.find((item) => item.name === 'FECULA MEDIA');
    expect(base?.prices.map((p) => p.sale_price)).toEqual([4500, 4000]);
    expect(base?.stock).toBe(20);
    expect(child?.stock).toBe(40);
    expect(child?.image).toBe('x/base.png');

    expect((await run(cids.product_share)).map((item) => item.name)).toEqual([
      'FECULA BASE',
      'FECULA MEDIA',
    ]);
    expect((await run(cids.odd_share)).map((item) => item.name)).toEqual(['EMPATE A']);
  });

  itDb('empates de created_at: orden determinista (por id)', async () => {
    const names = (await run(cids.main)).map((item) => item.name);
    expect(names.indexOf('EMPATE A')).toBeLessThan(names.indexOf('EMPATE B'));
  });

  itDb('barrido: TODAS las companies de la BD devuelven los mismos items', async () => {
    const companies = await q<{ id: string }>(`SELECT id FROM companies ORDER BY id`);
    let compared = 0;
    for (const { id } of companies) {
      const cid = Number(id);
      const next = await run(cid);
      expect(byId(next)).toEqual(byId(await run(cid, legacySql(cid))));
      expect(next).toEqual(await run(cid, legacySql(cid, true)));
      compared += next.length;
    }
    expect(compared).toBeGreaterThan(0);
  });

  itDb('la consulta nueva es la que usa la acción', () => {
    expect(buildPosItemsSql(cids.main).sql).toMatch(/ORDER BY p\.id/);
    return Promise.resolve();
  });
});
