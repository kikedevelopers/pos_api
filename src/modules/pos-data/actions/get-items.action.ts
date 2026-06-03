import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Item normalizado expuesto al frontend POS. Réplica del shape PlacePos
 * `normalizeProduct` pero SIN `stock`/`hash`/`is_purchasable` (no existen
 * en el modelo actual — ver TODO en `Product.entity.ts`).
 */
export interface PosItem {
  id: number;
  name: string;
  cost: number;
  bar_code: string;
  sku_code: string;
  parent_id: number | null;
  packaging_id: number | null;
  packaging: { id: number; name: string; value: number } | null;
  prices: { id: number; sale_price: number; profit: number; margin: number }[];
  parent: { id: number; name: string; cost: number } | null;
  /** Placeholder: stock real depende de columna ausente; TODO Fase 11.5. */
  stock: number;
}

/**
 * `GET /pos-data/items`. Listado pre-agregado de items vendibles en POS.
 *
 * Espejo PlacePos con dos divergencias documentadas:
 *
 *   1. `stock = 0` en todos los items: `Product.stock` no existe en el
 *      modelo actual (ver TODO en `product.entity.ts`). Hasta agregar la
 *      columna, el POS no puede vender por stock. TODO Fase 11.5.
 *
 *   2. Filtramos `show_in_pos = true` para PADRES e hijos. PlacePos hace
 *      un truco para mostrar hijos cuando el padre está oculto; lo
 *      preservamos pero con stock placeholder.
 *
 * Multi-tenancy: `repo.find({ where: { company_id, ... } })` filtra por el
 * tenant del JWT.
 */
/**
 * Fila cruda del SQL de items POS. `bigint`/`numeric` llegan como `string`
 * desde el driver `pg`; `created_at` como `Date`; `prices` como array JSON ya
 * parseado (jsonb). El LATERAL agrega los precios en 1 fila por producto.
 */
interface RawPosItemRow {
  id: string;
  name: string;
  cost: string | number;
  bar_code: string | null;
  sku_code: string | null;
  parent_id: string | null;
  packaging_id: string | null;
  packaging__id: string | null;
  packaging__name: string | null;
  packaging__value: string | number | null;
  show_in_pos: boolean;
  created_at: Date | string;
  /** stock real del producto (placeholder; el post-proceso usa 0). */
  stock: string | number;
  prices: { id: number | string; sale_price: number | string; profit: number | string; margin: number | string }[] | null;
}

@Injectable()
export class GetItemsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<PosItem[]> {
    // SQL crudo: 1 FILA POR PRODUCTO. `prices` agregado vía LEFT JOIN LATERAL
    // correlacionado (usa `idx_product_prices_product_id`), packaging como
    // LEFT JOIN escalar. NO se hidratan entidades TypeORM. El post-proceso JS
    // posterior es IDÉNTICO al anterior (filtro show_in_pos, parentMap,
    // childrenByParent, orden por created_at, stock:0 placeholder).
    const sql = `
      SELECT
        p.id            AS id,
        p.name          AS name,
        p.cost          AS cost,
        p.bar_code      AS bar_code,
        p.sku_code      AS sku_code,
        p.parent_id     AS parent_id,
        p.packaging_id  AS packaging_id,
        p.show_in_pos   AS show_in_pos,
        p.created_at    AS created_at,
        p.stock         AS stock,
        pk.id           AS packaging__id,
        pk.name         AS packaging__name,
        pk.value        AS packaging__value,
        COALESCE(pr.prices, '[]'::jsonb) AS prices
      FROM products p
      LEFT JOIN packagings pk ON pk.id = p.packaging_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id',         pp.id,
            'sale_price', pp.sale_price,
            'profit',     pp.profit,
            'margin',     pp.margin
          ) ORDER BY pp.id
        ) AS prices
        FROM product_prices pp
        WHERE pp.product_id = p.id
      ) pr ON TRUE
      WHERE p.company_id = $1 AND p.is_archived = false
    `;

    const rows = await this.dataSource.query<RawPosItemRow[]>(sql, [String(companyId)]);

    const normalized = rows.map((p) => ({
      id: Number(p.id),
      name: p.name,
      cost: Number(p.cost),
      bar_code: p.bar_code ?? '',
      sku_code: p.sku_code ?? '',
      parent_id: p.parent_id ? Number(p.parent_id) : null,
      packaging_id: p.packaging_id ? Number(p.packaging_id) : null,
      packaging:
        p.packaging__id !== null
          ? {
              id: Number(p.packaging__id),
              name: p.packaging__name as string,
              value: Number(p.packaging__value),
            }
          : null,
      show_in_pos: p.show_in_pos,
      created_at: p.created_at instanceof Date ? p.created_at : new Date(p.created_at),
      prices: (p.prices ?? []).map((pr) => ({
        id: Number(pr.id),
        sale_price: Number(pr.sale_price),
        profit: Number(pr.profit),
        margin: Number(pr.margin),
      })),
      // TODO Fase 11.5: stock real cuando Product.stock exista.
      stock: 0,
    }));

    const allParents = normalized.filter((p) => p.parent_id === null);
    const parentMap = new Map(allParents.map((p) => [p.id, p]));

    const childrenByParent = new Map<number, typeof normalized>();
    for (const child of normalized.filter((p) => p.parent_id !== null && p.show_in_pos)) {
      if (child.parent_id === null) {
        continue;
      }
      if (!parentMap.has(child.parent_id)) {
        continue;
      }
      const list = childrenByParent.get(child.parent_id) ?? [];
      list.push(child);
      childrenByParent.set(child.parent_id, list);
    }
    childrenByParent.forEach((children) =>
      children.sort((a, b) => a.created_at.getTime() - b.created_at.getTime()),
    );

    const orderedParents = allParents
      .filter((p) => p.show_in_pos || (childrenByParent.get(p.id)?.length ?? 0) > 0)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

    const items: PosItem[] = [];
    for (const parent of orderedParents) {
      const children = (childrenByParent.get(parent.id) ?? []).map((child) => {
        const packagingValue = child.packaging?.value || 1;
        return {
          id: child.id,
          name: child.name,
          cost: child.cost,
          bar_code: child.bar_code,
          sku_code: child.sku_code,
          parent_id: child.parent_id,
          packaging_id: child.packaging_id,
          packaging: child.packaging,
          prices: child.prices,
          stock: Math.floor(parent.stock / packagingValue),
          parent: { id: parent.id, name: parent.name, cost: parent.cost },
        };
      });
      if (parent.show_in_pos) {
        items.push({
          id: parent.id,
          name: parent.name,
          cost: parent.cost,
          bar_code: parent.bar_code,
          sku_code: parent.sku_code,
          parent_id: parent.parent_id,
          packaging_id: parent.packaging_id,
          packaging: parent.packaging,
          prices: parent.prices,
          stock: parent.stock,
          parent: null,
        });
      }
      items.push(...children);
    }

    return items;
  }
}
