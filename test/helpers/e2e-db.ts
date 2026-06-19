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
 * Crea una company desechable marcada como SUCURSAL (`is_branch = true`).
 * Limpia una previa con el mismo nombre.
 */
export async function createDisposableBranch(ds: DataSource, name: string): Promise<number> {
  const prev = await ds.query(`SELECT id FROM companies WHERE name = $1`, [name]);
  for (const row of prev) {
    await cleanupCompany(ds, parseInt(row.id, 10));
  }
  const created = await ds.query(
    `INSERT INTO companies (name, is_branch) VALUES ($1, true) RETURNING id`,
    [name],
  );
  return parseInt(created[0].id, 10);
}

/**
 * Inserta una membresía `company_members(user_id, company_id)` — requisito
 * anti-IDOR del clonado/switch (el owner debe ser miembro de la sucursal).
 */
export async function insertCompanyMember(
  ds: DataSource,
  userId: number,
  companyId: number,
): Promise<void> {
  await ds.query(
    `INSERT INTO company_members (user_id, company_id, role, is_active)
     VALUES ($1, $2, 'owner', true)
     ON CONFLICT (user_id, company_id) DO NOTHING`,
    [String(userId), String(companyId)],
  );
}

/**
 * Crea un usuario owner desechable ligado a `companyId` (su company primaria).
 * `company_members.user_id` tiene FK a `users`, así que el actor del clonado
 * debe ser un usuario real. Devuelve su id. Email único por sufijo.
 */
export async function insertOwnerUser(
  ds: DataSource,
  companyId: number,
  emailSuffix: string,
): Promise<number> {
  const r = await ds.query(
    `INSERT INTO users (name, lastname, email, password, type, company_id, branches_enabled, branches_allowed)
     VALUES ('E2E', 'Owner', $1, 'x', 'owner', $2, true, 10) RETURNING id`,
    [`__e2e_${emailSuffix}_${Date.now()}@example.test`, String(companyId)],
  );
  return parseInt(r[0].id, 10);
}

/**
 * Borra TODO el rastro de una company de prueba. El orden respeta las FKs:
 * historiales (RESTRICT a products) → movimientos/precios → hijos antes que
 * padres (parent_id RESTRICT) → padres → packagings → company.
 */
export async function cleanupCompany(ds: DataSource, companyId: number): Promise<void> {
  const cid = String(companyId);
  // FASE 2 (COMPARTIR): inventory_shares tiene FK RESTRICT a companies (source/
  // target); hay que borrar los vínculos antes de borrar la company.
  await ds.query(
    `DELETE FROM inventory_shares WHERE source_company_id = $1 OR target_company_id = $1`,
    [cid],
  );
  await ds.query(`DELETE FROM product_price_history WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM product_cost_history WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM inventory_movements WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM product_prices WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM products WHERE company_id = $1 AND parent_id IS NOT NULL`, [cid]);
  await ds.query(`DELETE FROM products WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM categories WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM packagings WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM app_settings WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM company_members WHERE company_id = $1`, [cid]);
  // Usuarios desechables ligados a esta company (su company primaria). Borrarlos
  // cascada-elimina sus company_members en OTRAS companies (FK ON DELETE CASCADE),
  // evitando dejar membresías colgantes del actor de prueba.
  await ds.query(`DELETE FROM users WHERE company_id = $1`, [cid]);
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
  'app_settings',
  'company_members',
  'users',
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
    barCode?: string | null;
    description?: string | null;
    categoryId?: string | null;
    productType?: 'SIMPLE' | 'COMBO';
    showInPos?: boolean;
    isPurchasable?: boolean;
  },
): Promise<string> {
  const r = await ds.query(
    `INSERT INTO products
       (company_id, name, description, cost, stock, parent_id, packaging_id,
        sku_code, bar_code, category_id, product_type, show_in_pos, is_purchasable, is_archived)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false)
     RETURNING id`,
    [
      String(companyId),
      opts.name,
      opts.description ?? null,
      opts.cost,
      opts.stock ?? 0,
      opts.parentId ?? null,
      opts.packagingId ?? null,
      opts.skuCode ?? null,
      opts.barCode ?? null,
      opts.categoryId ?? null,
      opts.productType ?? 'SIMPLE',
      opts.showInPos ?? true,
      opts.isPurchasable ?? false,
    ],
  );
  return r[0].id;
}

/** Inserta una categoría y devuelve su id. */
export async function insertCategory(
  ds: DataSource,
  companyId: number,
  name: string,
): Promise<string> {
  const r = await ds.query(
    `INSERT INTO categories (company_id, name, is_archived) VALUES ($1, $2, false) RETURNING id`,
    [String(companyId), name],
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
