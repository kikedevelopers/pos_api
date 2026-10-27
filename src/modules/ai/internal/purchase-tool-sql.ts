import {
  accessibleCompanyIdsSql,
  accessibleProductsPredicate,
} from '@/modules/products/internal/accessible-products.helper';

import { normalizeSearchSql } from './sale-tool-sql';

/**
 * SQL de las herramientas de documentos y compras de Place.
 *
 * Dos alcances, cada uno con el MISMO filtro de su pantalla canónica:
 *   - `inventory`  → lo que ve el Inventario (propios + compartidos por la
 *                    sucursal principal, no archivados). Para "¿qué stock
 *                    tengo de lo que dice esta factura?".
 *   - `purchasable`→ lo que se compra en la pantalla de Compras: productos
 *                    PROPIOS de la company, SIMPLE, no archivados (lo que
 *                    `POST /purchases` exige) y BASE — las presentaciones se
 *                    derivan del base y nunca se compran (regla del buscador
 *                    de Compras de placepos, `filterPurchasableProducts`).
 *                    No se filtra por `is_purchasable`: es solo un filtro de
 *                    presentación de ese buscador y una factura real manda.
 */

export type DocumentScope = 'inventory' | 'purchasable';

/** Tope del pool de candidatos por consulta. */
export const DOCUMENT_POOL_LIMIT = 600;

export interface DocumentPoolFilters {
  /** Patrones LIKE ya con comodines (`%acei%`), en minúsculas y sin tildes. */
  patterns: string[];
  /** Códigos (SKU / barras) exactos, en minúsculas. */
  codes: string[];
  /** Nombres confirmados por el usuario, ya normalizados (`normalizeText`). */
  names: string[];
}

const scopeSql = (
  scope: DocumentScope,
  company_id: number,
): { where: string; params: unknown[] } => {
  if (scope === 'purchasable') {
    return {
      where: `p.company_id = $1 AND p.is_archived = false AND p.product_type = 'SIMPLE' AND p.parent_id IS NULL`,
      params: [String(company_id)],
    };
  }
  const access = accessibleProductsPredicate('p', company_id, 1);
  return {
    where: `p.company_id IN (${accessibleCompanyIdsSql('$1')}) AND ${access.sql} AND p.is_archived = false`,
    params: [...access.params],
  };
};

/**
 * Pool liviano de candidatos para TODOS los ítems del documento en una
 * consulta. Lo dicho exacto (código, nombre confirmado) va primero para que el
 * tope nunca lo deje fuera.
 */
export const buildDocumentPoolSql = (
  scope: DocumentScope,
  company_id: number,
  filters: DocumentPoolFilters,
): { sql: string; params: unknown[] } => {
  const base = scopeSql(scope, company_id);
  const params: unknown[] = [...base.params];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const priority: string[] = [];
  const matches: string[] = [];
  if (filters.codes.length > 0) {
    const codes = push(filters.codes);
    priority.push(`lower(btrim(p.sku_code)) = ANY(${codes}::text[])`);
    priority.push(`lower(btrim(p.bar_code)) = ANY(${codes}::text[])`);
  }
  if (filters.names.length > 0) {
    // Misma normalización que `normalizeText`: sin tildes y sin signos.
    priority.push(
      `btrim(regexp_replace(${normalizeSearchSql('p.name')}, '[^a-z0-9]+', ' ', 'g')) = ANY(${push(filters.names)}::text[])`,
    );
  }
  if (filters.patterns.length > 0) {
    matches.push(`${normalizeSearchSql('p.name')} LIKE ANY(${push(filters.patterns)}::text[])`);
  }
  const all = [...priority, ...matches];
  if (all.length === 0) {
    all.push('false');
  }
  const priority_order =
    priority.length > 0 ? `COALESCE(${priority.join(' OR ')}, false) DESC, ` : '';

  const sql = `
    SELECT p.id::int AS id, p.name, p.sku_code, p.bar_code, pk.name AS packaging_name
      FROM products p
      LEFT JOIN packagings pk ON pk.id = p.packaging_id
     WHERE ${base.where}
       AND (${all.join('\n         OR ')})
     ORDER BY ${priority_order}p.name ASC, p.id ASC
     LIMIT ${DOCUMENT_POOL_LIMIT}
  `;
  return { sql, params };
};

/**
 * Detalle de los productos que van a la respuesta: existencias, costo,
 * empaque registrado, primer precio de venta y el costo de la ÚLTIMA compra
 * (por unidad mínima, para compararlo con lo facturado).
 */
export const buildDocumentDetailsSql = (
  scope: DocumentScope,
  company_id: number,
  product_ids: readonly number[],
): { sql: string; params: unknown[] } => {
  const base = scopeSql(scope, company_id);
  const params: unknown[] = [...base.params, product_ids.map(String)];
  const ids = `$${params.length}`;
  const sql = `
    SELECT p.id::int AS id, p.name, p.sku_code, p.bar_code, p.product_type,
           p.stock::text AS stock, p.cost::text AS cost,
           p.packaging_id::text AS packaging_id,
           pk.name AS packaging_name, pk.value::text AS packaging_value,
           parent.name AS parent_name,
           (SELECT pp.sale_price::text
              FROM product_prices pp
             WHERE pp.product_id = p.id
             ORDER BY pp.id
             LIMIT 1) AS sale_price,
           (SELECT pl.unit_price::text
              FROM purchase_lines pl
              JOIN purchases pu ON pu.id = pl.purchase_id
             WHERE pl.product_id = p.id
               AND pl.company_id = p.company_id
               AND pu.company_id = p.company_id
               AND pu.is_deleted = false
               AND pl.unit_price > 0
             ORDER BY pu.created_at DESC, pu.id DESC, pl.id DESC
             LIMIT 1) AS last_unit_cost
      FROM products p
      LEFT JOIN packagings pk ON pk.id = p.packaging_id
      LEFT JOIN products parent ON parent.id = p.parent_id
     WHERE p.id = ANY(${ids}::bigint[])
       AND ${base.where}
  `;
  return { sql, params };
};

/** Proveedores ACTIVOS del negocio (los archivados no se pueden comprar). $1 company_id. */
export const ACTIVE_SUPPLIERS_SQL = `
  SELECT id::text AS id, legal_name, doc_number
    FROM suppliers
   WHERE company_id = $1 AND is_archived = false
   ORDER BY legal_name ASC, id ASC
   LIMIT 2000
`;
