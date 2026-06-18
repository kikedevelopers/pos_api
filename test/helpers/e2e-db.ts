import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { dataSourceOptions } from '@/database/data-source';

// Carga `.env` para que el DataSource e2e tome las credenciales de pos_db
// fuera del contexto de Nest (igual que el CLI de TypeORM).
loadEnv();

/**
 * Helper compartido para los tests e2e con BD REAL (pos_db).
 *
 * Patrón anti-CI-rojo: `tryInitDataSource` intenta conectar; si NO hay BD
 * disponible, devuelve `null` en vez de lanzar. El spec usa
 * `canConnect ? describe : describe.skip` para skipear de forma limpia sin
 * romper `npm run test:e2e` en un runner sin Postgres.
 *
 * Reusa `dataSourceOptions` de `src/database/data-source.ts` (misma config y
 * entidades que el runtime). NUNCA toca companies reales: cada suite crea su
 * propia company desechable y la borra (con todo su rastro) en `afterAll`.
 */

/**
 * Intenta inicializar un DataSource contra pos_db. Devuelve el DataSource si
 * conecta, o `null` si la conexión falla (BD no disponible en el runner).
 */
export async function tryInitDataSource(): Promise<DataSource | null> {
  const ds = new DataSource({ ...dataSourceOptions, logging: false });
  try {
    await ds.initialize();
    // Sanity ping: confirma que la conexión responde.
    await ds.query('SELECT 1');
    return ds;
  } catch {
    // Si quedó medio-inicializado, intentamos cerrarlo silenciosamente.
    try {
      if (ds.isInitialized) {
        await ds.destroy();
      }
    } catch {
      /* noop */
    }
    return null;
  }
}

/** Actor de prueba para los actions (no hay FK en created_by_id). */
export const E2E_ACTOR = { id: 1, fullName: 'E2E_ITEST' } as const;

/**
 * Crea una company desechable con el nombre dado y devuelve su id numérico.
 * Si una corrida previa la dejó, la limpia primero.
 */
export async function createDisposableCompany(ds: DataSource, name: string): Promise<number> {
  const prev = await ds.query(`SELECT id FROM companies WHERE name = $1`, [name]);
  for (const row of prev) {
    await cleanupCompany(ds, parseInt(row.id, 10));
  }
  const created = await ds.query(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [name]);
  return parseInt(created[0].id, 10);
}

/**
 * Borra TODO el rastro de una company de prueba. El orden respeta las FKs:
 * historiales (RESTRICT a products) → movimientos/precios → hijos antes que
 * padres (parent_id RESTRICT) → padres → packagings → company.
 */
export async function cleanupCompany(ds: DataSource, companyId: number): Promise<void> {
  const cid = String(companyId);
  await ds.query(`DELETE FROM product_price_history WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM product_cost_history WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM inventory_movements WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM product_prices WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM products WHERE company_id = $1 AND parent_id IS NOT NULL`, [cid]);
  await ds.query(`DELETE FROM products WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM categories WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM packagings WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM companies WHERE id = $1`, [cid]);
}

/**
 * Cuenta filas de una company en una tabla. Para `companies` usa `id`.
 */
export async function countRows(ds: DataSource, table: string, companyId: number): Promise<number> {
  const col = table === 'companies' ? 'id' : 'company_id';
  const r = await ds.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = $1`, [
    String(companyId),
  ]);
  return parseInt(r[0].n, 10);
}

/**
 * Verifica que NO quede rastro de la company en todas las tablas tocadas por
 * estos tests. Lanza si alguna tiene filas (úsalo dentro de un `expect`).
 */
export const E2E_TABLES = [
  'product_price_history',
  'product_cost_history',
  'inventory_movements',
  'product_prices',
  'products',
  'categories',
  'packagings',
  'companies',
] as const;

// ─── Inserción de fixtures (SQL crudo, sin pasar por los actions) ───────────

export async function insertPackaging(
  ds: DataSource,
  companyId: number,
  name: string,
  value: number,
): Promise<string> {
  const r = await ds.query(
    `INSERT INTO packagings (company_id, name, value, is_archived, is_auto)
     VALUES ($1, $2, $3, false, false) RETURNING id`,
    [String(companyId), name, value],
  );
  return r[0].id;
}

export async function insertProduct(
  ds: DataSource,
  companyId: number,
  opts: {
    name: string;
    cost: number;
    stock?: number;
    parentId?: string | null;
    packagingId?: string | null;
    skuCode?: string | null;
  },
): Promise<string> {
  const r = await ds.query(
    `INSERT INTO products
       (company_id, name, cost, stock, parent_id, packaging_id, sku_code,
        product_type, show_in_pos, is_purchasable, is_archived)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'SIMPLE', true, false, false)
     RETURNING id`,
    [
      String(companyId),
      opts.name,
      opts.cost,
      opts.stock ?? 0,
      opts.parentId ?? null,
      opts.packagingId ?? null,
      opts.skuCode ?? null,
    ],
  );
  return r[0].id;
}

export async function insertPrice(
  ds: DataSource,
  companyId: number,
  productId: string,
  salePrice: number,
  profit: number,
  margin: number,
): Promise<string> {
  const r = await ds.query(
    `INSERT INTO product_prices
       (company_id, product_id, name, sale_price, profit, margin, iva_percentage)
     VALUES ($1, $2, '', $3, $4, $5, 0) RETURNING id`,
    [String(companyId), productId, salePrice, profit, margin],
  );
  return r[0].id;
}
