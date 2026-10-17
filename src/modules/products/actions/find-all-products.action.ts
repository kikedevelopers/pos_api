import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Product, ProductType } from '@/modules/products/entities/product.entity';

import type { InventoryQueryDto } from '../dto/inventory-query.dto';
import {
  accessibleCompanyIdsSql,
  accessibleProductsPredicate,
} from '../internal/accessible-products.helper';
import { attachComboComponentsTo } from '../internal/combo-components.helper';

/**
 * Lista productos de una company. Endpoint `GET /inventory`.
 *
 * Comportamiento paridad-PlacePos:
 *   1. Filtra `is_archived = false` por defecto. Si query trae
 *      `include_archived=true`, se incluyen.
 *   2. Carga `prices` y `packaging` (+`category`).
 *   3. Ordena por:
 *      - Padres primero (parent_id IS NULL),
 *      - Cada padre seguido de sus hijos,
 *      - Dentro de cada grupo, ORDER BY `created_at DESC`.
 *      (Replicamos `placepos/inventory.routes.ts` línea 280-300.)
 *   4. Si `search` está presente, filtra case-insensitive contra
 *      `name`, `sku_code`, `bar_code`. Extensión opt-in.
 *
 * Read puro — no requiere transacción.
 *
 * --------------------------------------------------------------------------
 * Optimización (SQL crudo)
 * --------------------------------------------------------------------------
 *
 * Antes: QueryBuilder `leftJoinAndSelect` de prices+packaging+category +
 * `getMany()`. El join one-to-many con `prices` MULTIPLICA filas (401 filas
 * → 339 entidades) y obliga a TypeORM a hidratar entidades + de-duplicar.
 *
 * Ahora: 1 FILA POR PRODUCTO. `prices` se agrega como `jsonb` vía LEFT JOIN
 * LATERAL correlacionado (usa `idx_product_prices_product_id`), y
 * `packaging`/`category` son LEFT JOIN escalares. No se hidratan entidades
 * TypeORM: mapeamos las filas crudas a objetos PLANOS con la MISMA forma que
 * `Product` espera el mapper `toProductResponseDto` + `sortParentsThenChildren`.
 *
 * El output (JSON de respuesta) es byte-equivalente al anterior.
 */
@Injectable()
export class FindAllProductsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, query: InventoryQueryDto): Promise<Product[]> {
    const { sql, params } = buildFindAllProductsSql(companyId, query);

    // JIT apagado SOLO para esta consulta: con el `OR` del predicado de acceso
    // el planificador sobreestima el costo y Postgres compilaba ~140 funciones
    // a código nativo en CADA carga del inventario (~220 ms de CPU por
    // request, más que toda la ejecución). Una consulta de ~2.500 filas nunca
    // amortiza esa compilación. `SET LOCAL` muere con la transacción.
    const rows = await this.dataSource.transaction(async (manager) => {
      await manager.query('SET LOCAL jit = off');
      return manager.query<RawProductRow[]>(sql, params);
    });

    const products = rows.map((r) => mapRawToProduct(r, companyId));
    // Los COMBO viajan con su receta: de ella sale su `stock_display`.
    await attachComboComponentsTo(this.dataSource.manager, products, companyId);

    return sortParentsThenChildren(products);
  }
}

/**
 * SQL del listado. Exportado para los tests de equivalencia y rendimiento.
 *
 * Optimización (oct 2026) — mismas filas y mismos valores que la versión
 * anterior (verificado con EXCEPT/deep-equal en todas las companies):
 *
 *   1. `p.company_id IN (companies candidatas)` antes del predicado de acceso:
 *      usa el índice por company en vez de evaluar el `OR` (con sus EXISTS)
 *      sobre el catálogo de TODOS los tenants. El predicado sigue siendo el gate.
 *   2. Última compra RECIBIDA en UNA agregación (`last_purchases`), recorriendo
 *      solo las compras recibidas de las companies candidatas y sus líneas por
 *      el índice `purchase_id`. Antes era una
 *      subconsulta correlacionada POR PRODUCTO sobre `purchase_lines`, sin un
 *      índice que empezara por `product_id`: miles de escaneos por request.
 *   3. JIT apagado para la consulta (ver `execute`).
 *   4. Precios con `json_agg`/`json_build_object` (texto) en vez de `jsonb`: el
 *      driver los parsea igual y `mapRawToProduct` reconstruye cada precio con
 *      claves explícitas, así que la salida es idéntica sin el costo de
 *      construir jsonb binario por fila.
 */
export function buildFindAllProductsSql(
  companyId: number,
  query: InventoryQueryDto,
): { sql: string; params: unknown[] } {
  // FASE 2 (COMPARTIR): visibilidad = propios + compartidos por el principal.
  // El predicado consume $1..$5 (la company activa repetida). El filtro de
  // edición/compra/precio NO usa esto (siguen `company_id = activa`).
  const accessPred = accessibleProductsPredicate('p', companyId, 1);
  const params: unknown[] = [...accessPred.params];
  const where: string[] = [
    'p.company_id IN (SELECT company_id FROM candidate_companies)',
    accessPred.sql,
  ];

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
    WITH candidate_companies (company_id) AS MATERIALIZED (${accessibleCompanyIdsSql('$1')}
    ),
    -- Última compra RECIBIDA (ingresada al inventario) que incluyó el producto.
    -- Solo compras RECEIVED (no PENDING) y no borradas, de la company DUEÑA del
    -- producto. Los purchase_lines se registran contra el producto BASE. null
    -- si nunca se recibió una compra con él (el front cae a created_at).
    last_purchases AS (
      SELECT pur.company_id, pl.product_id, MAX(pur.received_at) AS last_purchase_date
        FROM purchases pur
        -- Las líneas de CADA compra por su índice de purchase_id (el OFFSET 0 evita
        -- que el planificador lo aplane en un hash join con seq scan de TODAS las
        -- purchase_lines de todos los tenants).
        CROSS JOIN LATERAL (
          SELECT l.product_id FROM purchase_lines l WHERE l.purchase_id = pur.id OFFSET 0
        ) pl
       WHERE pur.company_id IN (SELECT company_id FROM candidate_companies)
         AND pur.is_deleted = false
         AND pur.status = 'RECEIVED'
       GROUP BY pur.company_id, pl.product_id
    )
    SELECT
      p.id              AS id,
      p.name            AS name,
      p.description     AS description,
      p.product_type    AS product_type,
      p.parent_id       AS parent_id,
      p.sku_code        AS sku_code,
      p.bar_code        AS bar_code,
      p.packaging_id    AS packaging_id,
      p.category_id     AS category_id,
      p.tax_rate_id     AS tax_rate_id,
      p.cost            AS cost,
      p.stock           AS stock,
      p.is_purchasable  AS is_purchasable,
      p.image           AS image,
      p.show_in_pos     AS show_in_pos,
      p.catalog_visible AS catalog_visible,
      p.catalog_out_of_stock AS catalog_out_of_stock,
      p.is_archived     AS is_archived,
      p.created_by      AS created_by,
      p.updated_by      AS updated_by,
      p.created_at      AS created_at,
      p.updated_at      AS updated_at,
      p.company_id      AS company_id,
      p.cloned_from_company_id AS cloned_from_company_id,
      lp.last_purchase_date AS last_purchase_date,
      pk.id             AS packaging__id,
      pk.name           AS packaging__name,
      pk.value          AS packaging__value,
      pk.is_auto        AS packaging__is_auto,
      cat.id            AS category__id,
      cat.name          AS category__name,
      COALESCE(pr.prices, '[]'::json) AS prices
    FROM products p
    LEFT JOIN last_purchases lp ON lp.product_id = p.id AND lp.company_id = p.company_id
    LEFT JOIN packagings pk ON pk.id = p.packaging_id
    LEFT JOIN categories  cat ON cat.id = p.category_id
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'id',             pp.id,
          'name',           pp.name,
          'sale_price',     pp.sale_price,
          'profit',         pp.profit,
          'margin',         pp.margin,
          'iva_percentage', pp.iva_percentage,
          'taxable_base',   pp.taxable_base,
          'tax_amount',     pp.tax_amount
        ) ORDER BY pp.id
      ) AS prices
      FROM product_prices pp
      WHERE pp.product_id = p.id
    ) pr ON TRUE
    WHERE ${where.join(' AND ')}
    -- Desempate por id: con imports masivos muchos productos comparten
    -- created_at y el orden de esos empates no puede depender del plan.
    ORDER BY p.created_at DESC, p.id DESC
  `;
  return { sql, params };
}

/**
 * Fila cruda del SQL. Los `numeric`/`bigint` llegan como `string` desde el
 * driver `pg`; `created_at`/`updated_at` como `Date` (timestamptz); `prices`
 * como array JSON ya parseado por el driver (jsonb).
 */
interface RawProductRow {
  id: string;
  company_id?: string | null;
  cloned_from_company_id?: string | null;
  name: string;
  description: string | null;
  product_type: ProductType;
  parent_id: string | null;
  sku_code: string | null;
  bar_code: string | null;
  packaging_id: string | null;
  category_id: string | null;
  tax_rate_id: string | null;
  cost: string | number;
  stock: string | number;
  is_purchasable: boolean;
  image: string | null;
  show_in_pos: boolean;
  catalog_visible: boolean;
  catalog_out_of_stock: boolean;
  is_archived: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_purchase_date: Date | string | null;
  packaging__id: string | null;
  packaging__name: string | null;
  packaging__value: string | number | null;
  packaging__is_auto: boolean | null;
  category__id: string | null;
  category__name: string | null;
  prices: RawPriceJson[] | null;
}

interface RawPriceJson {
  id: number | string;
  name: string | null;
  sale_price: number | string;
  profit: number | string;
  margin: number | string;
  iva_percentage: number | string;
  taxable_base: number | string;
  tax_amount: number | string;
}

/**
 * Mapea una fila cruda a un objeto PLANO con la MISMA forma que la entidad
 * `Product` consume el resto del pipeline (`sortParentsThenChildren` +
 * `toProductResponseDto`). NO crea una entidad TypeORM — sólo replica las
 * propiedades leídas aguas abajo.
 *
 * Invariantes de tipo preservadas (equivalencia byte-a-byte):
 *   - `id` y `parent_id` quedan como `string`/`string | null` (igual que la
 *     entidad: pg devuelve bigint como string). El controller usa `id` como
 *     clave de Map y `parent_id` como lookup — deben ser del mismo tipo.
 *   - `created_at`/`updated_at` se normalizan a `Date` (el mapper llama
 *     `.toISOString()` y `sortParentsThenChildren` llama `.getTime()`).
 *   - `cost`/`stock`/precios quedan como vienen; el mapper aplica `Number(...)`
 *     igual que el `NumericTransformer` hacía.
 */
function mapRawToProduct(r: RawProductRow, activeCompanyId: number): Product {
  const ownerCompanyId =
    r.company_id !== undefined && r.company_id !== null ? Number(r.company_id) : activeCompanyId;
  const product = {
    id: r.id,
    company_id: r.company_id,
    // FASE 2: marca solo-lectura para el front si el producto es de otra company
    // (compartido por el principal).
    is_shared: ownerCompanyId !== activeCompanyId,
    owner_company_id: ownerCompanyId,
    // COPIA: producto propio de la sucursal pero clonado desde el principal.
    is_clone: r.cloned_from_company_id !== undefined && r.cloned_from_company_id !== null,
    name: r.name,
    description: r.description,
    product_type: r.product_type,
    parent_id: r.parent_id,
    sku_code: r.sku_code,
    bar_code: r.bar_code,
    packaging_id: r.packaging_id,
    category_id: r.category_id,
    tax_rate_id: r.tax_rate_id,
    cost: r.cost,
    stock: r.stock,
    is_purchasable: r.is_purchasable,
    image: r.image,
    show_in_pos: r.show_in_pos,
    catalog_visible: r.catalog_visible,
    catalog_out_of_stock: r.catalog_out_of_stock,
    is_archived: r.is_archived,
    created_by: r.created_by,
    updated_by: r.updated_by,
    created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    updated_at: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
    last_purchase_date:
      r.last_purchase_date == null
        ? null
        : (r.last_purchase_date instanceof Date
            ? r.last_purchase_date
            : new Date(r.last_purchase_date)
          ).toISOString(),
    packaging:
      r.packaging__id !== null
        ? {
            id: r.packaging__id,
            name: r.packaging__name,
            value: r.packaging__value,
            is_auto: r.packaging__is_auto === true,
          }
        : null,
    category:
      r.category__id !== null
        ? {
            id: r.category__id,
            name: r.category__name,
          }
        : null,
    prices: (r.prices ?? []).map((pp) => ({
      id: pp.id,
      name: pp.name,
      sale_price: pp.sale_price,
      profit: pp.profit,
      margin: pp.margin,
      iva_percentage: pp.iva_percentage,
      taxable_base: pp.taxable_base,
      tax_amount: pp.tax_amount,
    })),
  };
  // El shape plano contiene todas las propiedades que el mapper lee; el cast
  // documenta que NO es una entidad TypeORM hidratada (sin métodos/relaciones
  // perezosas), sólo un POJO con la forma consumida aguas abajo.
  return product as unknown as Product;
}

/**
 * Ordena: padres primero (por `created_at DESC`), seguidos de sus hijos
 * (también `created_at DESC`). Espejo de PlacePos.
 *
 * Exportada para tests unitarios. INTACTA respecto a la versión anterior.
 */
export function sortParentsThenChildren(products: Product[]): Product[] {
  const parents = products
    .filter((p) => p.parent_id === null || p.parent_id === undefined)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

  const childrenByParent = new Map<string, Product[]>();
  for (const child of products) {
    if (child.parent_id !== null && child.parent_id !== undefined) {
      const list = childrenByParent.get(child.parent_id) ?? [];
      list.push(child);
      childrenByParent.set(child.parent_id, list);
    }
  }

  for (const list of childrenByParent.values()) {
    list.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }

  const result: Product[] = [];
  for (const parent of parents) {
    result.push(parent);
    const children = childrenByParent.get(parent.id);
    if (children) {
      result.push(...children);
    }
  }

  // Edge case: hijos huérfanos cuyo parent no está en el set (porque está
  // archivado y el query filtró). Los añadimos al final para no perderlos.
  const consumedIds = new Set(result.map((p) => p.id));
  for (const p of products) {
    if (!consumedIds.has(p.id)) {
      result.push(p);
    }
  }

  return result;
}
