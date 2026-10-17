import { ACCENTED, UNACCENTED } from '@/modules/categories/internal/category-lookups';
import {
  accessibleCompanyIdsSql,
  accessibleProductsPredicate,
} from '@/modules/products/internal/accessible-products.helper';

/**
 * SQL de la herramienta de PEDIDOS de Place.
 *
 * Velocidad: la preparación de un pedido hace, como mucho, CUATRO viajes
 * cortos a la BD (pool de candidatos, detalle de precios de los elegidos,
 * cliente y configuración de márgenes), los independientes en paralelo. El pool
 * trae solo columnas livianas (id, nombre, códigos, empaque) — el puntaje fino
 * se hace en memoria (`sale-product-matching.ts`) y los precios se piden solo
 * para los productos que de verdad van al resumen.
 *
 * Multi-tenant: TODA consulta filtra por la company del JWT. Los productos con
 * `accessibleProductsPredicate` (propios + los que la sucursal principal
 * comparte, misma regla que el POS y que `POST /sales`); los clientes con
 * `company_id` directo. La escritura del pedido NO está aquí: se delega a
 * `CreateSaleAction.runInTransaction`, que revalida todo otra vez.
 */

/** Tope del pool de candidatos (un tenant grande tiene ~2.500 productos). */
export const CANDIDATE_POOL_LIMIT = 400;

/** Clientes candidatos que se le muestran al usuario. */
export const CUSTOMER_CANDIDATES_LIMIT = 8;

/**
 * Texto normalizado igual que en memoria (`parseProductText`): minúsculas, sin
 * tildes y con la "ñ" como "n" — así "pina" encuentra "PIÑA" y "munoz" a
 * "MUÑOZ". Se aplica a AMBOS lados de la comparación.
 */
export const normalizeSearchSql = (column: string): string =>
  `translate(lower(btrim(${column})), '${ACCENTED}ñ', '${UNACCENTED}n')`;

/** Predicado común: lo que el POS deja vender. */
const SELLABLE_CONDITIONS = `
  p.is_archived = false
  AND p.show_in_pos = true
  AND p.product_type IN ('SIMPLE', 'COMBO')`;

export interface CandidatePoolFilters {
  /** Patrones LIKE ya con comodines (`%fecu%`), en minúsculas y sin tildes. */
  patterns: string[];
  /** SKU / códigos de barras exactos, en minúsculas. */
  codes: string[];
  /** Ids que el modelo ya eligió de una lista anterior. */
  product_ids: number[];
}

/**
 * Pool liviano de candidatos para TODAS las líneas del pedido en una sola
 * consulta. `$1..$5` = predicado de acceso; luego patrones, códigos e ids.
 */
export const buildCandidatePoolSql = (
  company_id: number,
  filters: CandidatePoolFilters,
): { sql: string; params: unknown[] } => {
  const access = accessibleProductsPredicate('p', company_id, 1);
  const params: unknown[] = [...access.params];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const matches: string[] = [];
  // Lo elegido o dicho exacto (id, código) va PRIMERO: el tope del pool nunca
  // lo deja por fuera aunque haya cientos de coincidencias por nombre.
  const priority: string[] = [];
  if (filters.patterns.length > 0) {
    matches.push(`${normalizeSearchSql('p.name')} LIKE ANY(${push(filters.patterns)}::text[])`);
  }
  if (filters.codes.length > 0) {
    const codes = push(filters.codes);
    priority.push(`lower(btrim(p.sku_code)) = ANY(${codes}::text[])`);
    priority.push(`lower(btrim(p.bar_code)) = ANY(${codes}::text[])`);
  }
  if (filters.product_ids.length > 0) {
    priority.push(`p.id = ANY(${push(filters.product_ids.map(String))}::bigint[])`);
  }
  const all = [...priority, ...matches];
  if (all.length === 0) {
    all.push('false');
  }
  const priority_order =
    priority.length > 0 ? `COALESCE(${priority.join(' OR ')}, false) DESC, ` : '';

  const sql = `
    SELECT p.id, p.name, p.sku_code, p.bar_code, pk.name AS packaging_name
      FROM products p
      LEFT JOIN packagings pk ON pk.id = p.packaging_id
     WHERE p.company_id IN (${accessibleCompanyIdsSql('$1')})
       AND ${access.sql}
       AND ${SELLABLE_CONDITIONS}
       AND (${all.join('\n         OR ')})
     ORDER BY ${priority_order}p.name ASC, p.id ASC
     LIMIT ${CANDIDATE_POOL_LIMIT}
  `;
  return { sql, params };
};

/**
 * Detalle vendible de productos concretos: costo, existencias (y las del
 * padre, para las presentaciones), factor de empaque y niveles de precio en el
 * MISMO orden que el POS (`ORDER BY pp.id` → `price_position`).
 *
 * Se usa al preparar (solo para los elegidos/sugeridos) y al CONFIRMAR, dentro
 * de la transacción, para comparar contra lo que vio el usuario.
 */
export const buildSellableDetailsSql = (
  company_id: number,
  product_ids: readonly number[],
): { sql: string; params: unknown[] } => {
  const access = accessibleProductsPredicate('p', company_id, 1);
  const params: unknown[] = [...access.params, product_ids.map(String)];
  const ids = `$${params.length}`;
  const sql = `
    SELECT p.id, p.name, p.sku_code, p.bar_code, p.product_type,
           p.cost::text AS cost, p.stock::text AS stock, p.parent_id,
           parent.stock::text AS parent_stock,
           pk.name AS packaging_name, pk.value::text AS packaging_value,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', pp.id, 'name', pp.name, 'sale_price', pp.sale_price::text
                    ) ORDER BY pp.id)
               FROM product_prices pp
              WHERE pp.product_id = p.id
           ), '[]'::jsonb) AS prices
      FROM products p
      LEFT JOIN products parent ON parent.id = p.parent_id
      LEFT JOIN packagings pk ON pk.id = p.packaging_id
     WHERE p.id = ANY(${ids}::bigint[])
       AND ${access.sql}
       AND ${SELLABLE_CONDITIONS}
  `;
  return { sql, params };
};

/**
 * Clientes activos de la company que coinciden con TODAS las palabras del
 * texto (en cualquier orden, sin tildes): "juan perez" encuentra a
 * "JUAN CARLOS PÉREZ". También por documento o teléfono exactos. Primero las
 * coincidencias exactas de nombre/documento/teléfono.
 *
 * `total_matches` dice cuántos hay aunque la lista venga recortada.
 */
export const buildCustomerSearchSql = (
  company_id: number,
  query: string,
): { sql: string; params: unknown[] } => {
  const params: unknown[] = [String(company_id)];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const words = query
    .split(/\s+/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0)
    .slice(0, 6);
  const name_conditions = words.map(
    (word) =>
      `${normalizeSearchSql('c.name')} LIKE ${normalizeSearchSql(
        push(`%${word.replace(/[\\%_]/g, '\\$&')}%`),
      )}`,
  );
  const exact = push(query.trim());
  const name_match = name_conditions.length > 0 ? `(${name_conditions.join(' AND ')})` : 'false';

  const sql = `
    SELECT c.id, c.name, c.doc_number, c.phone,
           (${normalizeSearchSql('c.name')} = ${normalizeSearchSql(exact)}
             OR btrim(c.doc_number) = btrim(${exact})
             OR btrim(c.phone) = btrim(${exact})) AS is_exact,
           count(*) OVER () AS total_matches
      FROM customers c
     WHERE c.company_id = $1
       AND c.is_archived = false
       AND (${name_match}
            OR btrim(c.doc_number) = btrim(${exact})
            OR btrim(c.phone) = btrim(${exact}))
     ORDER BY is_exact DESC, c.name ASC, c.id ASC
     LIMIT ${CUSTOMER_CANDIDATES_LIMIT}
  `;
  return { sql, params };
};

/** Tope de candidatos aproximados que se puntúan en memoria. */
export const CUSTOMER_FUZZY_POOL_LIMIT = 300;

/**
 * Candidatos APROXIMADOS cuando ningún cliente contiene las palabras exactas
 * (error de tipeo: "Jhoanna" por "JHOANA"): clientes activos cuyo nombre
 * contiene el inicio (3 letras) de alguna palabra. El puntaje fino lo hace
 * `rankSimilarNames`. `null` si no hay palabras con qué buscar.
 */
export const buildCustomerFuzzySql = (
  company_id: number,
  query: string,
): { sql: string; params: unknown[] } | null => {
  const stems = [
    ...new Set(
      query
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3)
        .map((word) => `%${word.slice(0, 3)}%`),
    ),
  ].slice(0, 6);
  if (stems.length === 0) {
    return null;
  }
  const sql = `
    SELECT c.id, c.name, c.doc_number, c.phone
      FROM customers c
     WHERE c.company_id = $1
       AND c.is_archived = false
       AND ${normalizeSearchSql('c.name')} LIKE ANY($2::text[])
     ORDER BY c.name ASC, c.id ASC
     LIMIT ${CUSTOMER_FUZZY_POOL_LIMIT}
  `;
  return { sql, params: [String(company_id), stems] };
};

/** Un cliente activo por id, solo de esta company. $1 id, $2 company_id. */
export const FIND_ACTIVE_CUSTOMER_SQL = `
  SELECT c.id, c.name, c.doc_number, c.phone
    FROM customers c
   WHERE c.id = $1 AND c.company_id = $2 AND c.is_archived = false
`;
