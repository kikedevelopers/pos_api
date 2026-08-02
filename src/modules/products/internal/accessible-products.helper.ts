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
 *       presentación de un producto compartido también se ve/vende, O
 *   (5) `p` es COMPONENTE de la receta de un COMBO compartido accesible — sin
 *       esta regla, compartir SOLO un combo (share product-level) dejaría sus
 *       bases fuera del set accesible y el cobro reventaría al intentar
 *       descontarles stock.
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
export interface AccessiblePredicateOptions {
  /**
   * Incluir la REGLA 5 (componentes de un combo compartido).
   *
   * Cuesta caro: es un EXISTS con JOIN a `combo_components` más dos EXISTS
   * anidados, evaluado por cada fila candidata. En un listado masivo (que
   * escanea `products` entera) multiplica el tiempo del plan; medido sobre una
   * BD real: 0,9 ms → 26,5 ms.
   *
   * Solo hace falta al resolver IDS CONCRETOS, que es el camino donde el motor
   * de inventario necesita alcanzar un componente para descontarlo. En los
   * listados, además, incluirlo sería INCORRECTO: la sucursal no debe ver ni
   * vender suelto el componente de un combo compartido — solo el combo.
   *
   * Por eso el default es `false` y `resolveAccessibleProducts` lo activa.
   */
  includeComboComponents?: boolean;
}

export function accessibleProductsPredicate(
  alias: string,
  activeCompanyId: number,
  startParamIndex: number,
  options: AccessiblePredicateOptions = {},
): { sql: string; params: string[] } {
  const cid = String(activeCompanyId);
  const includeComboComponents = options.includeComboComponents === true;
  // 5 placeholders para las reglas 1-4; 7 si además entra la regla 5.
  const p = (offset: number): string => `$${startParamIndex + offset}`;

  // REGLA 5 — opt-in (ver `AccessiblePredicateOptions.includeComboComponents`).
  const comboComponentsRule = includeComboComponents
    ? `OR EXISTS (
      SELECT 1
      FROM combo_components cc
      JOIN products combo
        ON combo.id = cc.combo_product_id
       AND combo.company_id = cc.company_id
      WHERE cc.component_product_id = ${alias}.id
        AND cc.company_id = ${alias}.company_id
        AND (
          EXISTS (
            SELECT 1 FROM inventory_shares s3
            WHERE s3.target_company_id = ${p(5)}
              AND s3.product_id IS NULL
              AND s3.source_company_id = combo.company_id
          )
          OR EXISTS (
            SELECT 1 FROM inventory_shares s3
            WHERE s3.target_company_id = ${p(6)}
              AND s3.product_id = combo.id
          )
        )
    )`
    : '';

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
    ${comboComponentsRule}
  )`;

  return {
    sql,
    params: includeComboComponents
      ? [cid, cid, cid, cid, cid, cid, cid]
      : [cid, cid, cid, cid, cid],
  };
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
  /** Tipo del producto — el motor de inventario expande los COMBO en su receta. */
  productType: string;
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
  // Ids concretos: aquí SÍ hace falta la regla 5 — es el camino por el que el
  // motor de inventario alcanza el componente de un combo compartido.
  const pred = accessibleProductsPredicate('p', activeCompanyId, 2, {
    includeComboComponents: true,
  });

  const rows = await manager.query<
    Array<{
      id: string;
      company_id: string;
      parent_id: string | null;
      packaging_id: string | null;
      name: string;
      product_type: string;
    }>
  >(
    `SELECT p.id, p.company_id, p.parent_id, p.packaging_id, p.name, p.product_type
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
      productType: row.product_type,
    });
  }
  return map;
}
