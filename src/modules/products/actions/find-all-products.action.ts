import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Product, ProductType } from '@/modules/products/entities/product.entity';

import type { InventoryQueryDto } from '../dto/inventory-query.dto';

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
    const params: unknown[] = [String(companyId)];
    const where: string[] = ['p.company_id = $1'];

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
        p.id              AS id,
        p.name            AS name,
        p.description     AS description,
        p.product_type    AS product_type,
        p.parent_id       AS parent_id,
        p.sku_code        AS sku_code,
        p.bar_code        AS bar_code,
        p.packaging_id    AS packaging_id,
        p.category_id     AS category_id,
        p.cost            AS cost,
        p.stock           AS stock,
        p.is_purchasable  AS is_purchasable,
        p.image           AS image,
        p.show_in_pos     AS show_in_pos,
        p.is_archived     AS is_archived,
        p.created_by      AS created_by,
        p.updated_by      AS updated_by,
        p.created_at      AS created_at,
        p.updated_at      AS updated_at,
        pk.id             AS packaging__id,
        pk.name           AS packaging__name,
        pk.value          AS packaging__value,
        pk.is_auto        AS packaging__is_auto,
        cat.id            AS category__id,
        cat.name          AS category__name,
        COALESCE(pr.prices, '[]'::jsonb) AS prices
      FROM products p
      LEFT JOIN packagings pk ON pk.id = p.packaging_id
      LEFT JOIN categories  cat ON cat.id = p.category_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id',             pp.id,
            'name',           pp.name,
            'sale_price',     pp.sale_price,
            'profit',         pp.profit,
            'margin',         pp.margin,
            'iva_percentage', pp.iva_percentage
          ) ORDER BY pp.id
        ) AS prices
        FROM product_prices pp
        WHERE pp.product_id = p.id
      ) pr ON TRUE
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC
    `;

    const rows = await this.dataSource.query<RawProductRow[]>(sql, params);

    return sortParentsThenChildren(rows.map(mapRawToProduct));
  }
}

/**
 * Fila cruda del SQL. Los `numeric`/`bigint` llegan como `string` desde el
 * driver `pg`; `created_at`/`updated_at` como `Date` (timestamptz); `prices`
 * como array JSON ya parseado por el driver (jsonb).
 */
interface RawProductRow {
  id: string;
  name: string;
  description: string | null;
  product_type: ProductType;
  parent_id: string | null;
  sku_code: string | null;
  bar_code: string | null;
  packaging_id: string | null;
  category_id: string | null;
  cost: string | number;
  stock: string | number;
  is_purchasable: boolean;
  image: string | null;
  show_in_pos: boolean;
  is_archived: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
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
function mapRawToProduct(r: RawProductRow): Product {
  const product = {
    id: r.id,
    name: r.name,
    description: r.description,
    product_type: r.product_type,
    parent_id: r.parent_id,
    sku_code: r.sku_code,
    bar_code: r.bar_code,
    packaging_id: r.packaging_id,
    category_id: r.category_id,
    cost: r.cost,
    stock: r.stock,
    is_purchasable: r.is_purchasable,
    image: r.image,
    show_in_pos: r.show_in_pos,
    is_archived: r.is_archived,
    created_by: r.created_by,
    updated_by: r.updated_by,
    created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    updated_at: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
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
