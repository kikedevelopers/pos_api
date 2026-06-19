import type { EntityManager } from 'typeorm';

/**
 * FASE 2 (COMPARTIR) — Helper de VISIBILIDAD de productos cross-company.
 *
 * Un producto `p` es ACCESIBLE para la company activa B si:
 *   (1) `p.company_id = B`  (propio), O
 *   (2) existe un share COMPANY-LEVEL `A → B` (product_id NULL) y
 *       `p.company_id = A`  (A comparte TODO su catálogo con B), O
 *   (3) existe un share PRODUCT-LEVEL `(A → B, product_id = p.id)`, O
 *   (4) `p` es HIJO (`parent_id`) de un producto compartido accesible — así una
 *       presentación/combo hijo de un producto compartido también se ve/vende.
 *
 * El share es solo lectura/venta: el producto sigue siendo del principal. Este
 * helper solo decide VISIBILIDAD; el descuento de stock (que pega en el dueño
 * real) lo maneja `adjustInventory` con el `company_id` real del producto.
 */

/**
 * Construye un PREDICADO SQL booleano (para usar en un WHERE) que es `true`
 * cuando el producto con alias `alias` es accesible para `activeCompanyId`.
 *
 * El predicado NO referencia tablas externas salvo subconsultas EXISTS sobre
 * `inventory_shares` y un self-join a `products` para la regla del padre. Usa
 * placeholders POSICIONALES de Postgres (`$N`) a partir de `startParamIndex`.
 *
 * Devuelve el texto del predicado y los params que hay que ANEXAR (en orden) a
 * la lista de params de la query. `activeCompanyId` aparece varias veces, así
 * que se anexa varias veces (Postgres no reusa `$N` por valor lógico aquí para
 * mantener el generador simple y sin estado).
 */
export function accessibleProductsPredicate(
  alias: string,
  activeCompanyId: number,
  startParamIndex: number,
): { sql: string; params: string[] } {
  const cid = String(activeCompanyId);
  // Reservamos 5 placeholders consecutivos para las 5 apariciones de cid.
  const p = (offset: number): string => `$${startParamIndex + offset}`;

  const sql = `(
    ${alias}.company_id = ${p(0)}
    OR EXISTS (
      SELECT 1 FROM inventory_shares s
      WHERE s.target_company_id = ${p(1)}
        AND s.product_id IS NULL
        AND s.source_company_id = ${alias}.company_id
    )
    OR EXISTS (
      SELECT 1 FROM inventory_shares s
      WHERE s.target_company_id = ${p(2)}
        AND s.product_id = ${alias}.id
    )
    OR (
      ${alias}.parent_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM products parent
        WHERE parent.id = ${alias}.parent_id
          AND parent.company_id = ${alias}.company_id
          AND (
            EXISTS (
              SELECT 1 FROM inventory_shares s2
              WHERE s2.target_company_id = ${p(3)}
                AND s2.product_id IS NULL
                AND s2.source_company_id = parent.company_id
            )
            OR EXISTS (
              SELECT 1 FROM inventory_shares s2
              WHERE s2.target_company_id = ${p(4)}
                AND s2.product_id = parent.id
            )
          )
      )
    )
  )`;

  return { sql, params: [cid, cid, cid, cid, cid] };
}

/**
 * Resultado de resolver un producto accesible: su id y la company DUEÑA REAL
 * (donde vive su fila y su stock). Para un producto propio, `ownerCompanyId`
 * == la company activa; para uno compartido, la company del principal.
 */
export interface AccessibleProductRef {
  id: number;
  ownerCompanyId: number;
  parentId: number | null;
  packagingId: number | null;
  name: string;
  isShared: boolean;
}

/**
 * Resuelve un conjunto de ids de producto al subconjunto ACCESIBLE para
 * `activeCompanyId`, devolviendo por cada uno su company DUEÑA real. Un id NO
 * accesible simplemente no aparece en el Map (el caller decide si es error).
 *
 * Multi-tenant seguro: solo expone filas accesibles según las reglas del share.
 */
export async function resolveAccessibleProducts(
  manager: EntityManager,
  activeCompanyId: number,
  productIds: number[],
): Promise<Map<number, AccessibleProductRef>> {
  const map = new Map<number, AccessibleProductRef>();
  if (productIds.length === 0) {
    return map;
  }
  const uniqueIds = Array.from(new Set(productIds.map((id) => String(id))));
  const pred = accessibleProductsPredicate('p', activeCompanyId, 2);

  const rows = await manager.query<
    Array<{
      id: string;
      company_id: string;
      parent_id: string | null;
      packaging_id: string | null;
      name: string;
    }>
  >(
    `SELECT p.id, p.company_id, p.parent_id, p.packaging_id, p.name
     FROM products p
     WHERE p.id = ANY($1::bigint[]) AND ${pred.sql}`,
    [uniqueIds, ...pred.params],
  );

  for (const row of rows) {
    const ownerCompanyId = Number(row.company_id);
    map.set(Number(row.id), {
      id: Number(row.id),
      ownerCompanyId,
      parentId: row.parent_id !== null ? Number(row.parent_id) : null,
      packagingId: row.packaging_id !== null ? Number(row.packaging_id) : null,
      name: row.name,
      isShared: ownerCompanyId !== activeCompanyId,
    });
  }
  return map;
}
