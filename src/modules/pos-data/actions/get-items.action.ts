import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ProductType } from '@/modules/products/entities/product.entity';
import { accessibleProductsPredicate } from '@/modules/products/internal/accessible-products.helper';
import {
  comboStockFromComponents,
  loadComboRecipes,
} from '@/modules/products/internal/combo-components.helper';
import {
  computeChildStockDisplay,
  computeStockDisplay,
} from '@/modules/products/internal/compute-stock-display';

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
  /**
   * Tipo del producto. El POS lo usa para etiquetar la tarjeta ("Combo" vs
   * "Base"/"Presentación"). Un COMBO no tiene stock propio: se vende
   * explotando su receta contra el stock de los componentes.
   */
  product_type: ProductType;
  packaging: { id: number; name: string; value: number; is_auto: boolean } | null;
  prices: { id: number; sale_price: number; profit: number; margin: number }[];
  /**
   * Padre de una presentación. `stock` va CRUDO (unidad mínima) porque el
   * caché optimista del POS lo usa como base para recalcular la
   * disponibilidad de los hermanos tras vender — espejo de PlacePos
   * (`PosProductParent`), donde este campo siempre viajó.
   */
  parent: { id: number; name: string; stock: number; cost: number } | null;
  /**
   * Stock que ve el usuario, en la MISMA unidad que el módulo de inventario
   * (`stock_display`): paquetes para un base con empaque, unidades derivadas
   * del padre para una presentación, y unidades armables para un combo.
   */
  stock: number;
  /**
   * FASE 2 (COMPARTIR): `true` si el producto NO es de la company activa sino
   * compartido por el principal. El front lo muestra como solo-lectura.
   */
  is_shared: boolean;
  /** Company DUEÑA real del producto (el principal si es compartido). */
  owner_company_id: number;
}

/**
 * `GET /pos-data/items`. Listado pre-agregado de items vendibles en POS.
 *
 * Espejo PlacePos (`pos-data.routes.ts → GET /items`), incluido el cálculo del
 * stock mostrado, que sigue las MISMAS tres reglas del inventario
 * (`toProductResponseDto`) para que el POS y el inventario nunca discrepen:
 *
 *   - base:         `stock / packaging.value`
 *   - presentación: `stock_del_PADRE / packaging.value_del_HIJO`
 *   - combo:        unidades armables con el stock de sus componentes
 *
 * Filtramos `show_in_pos = true` para PADRES e hijos, con el truco de PlacePos
 * para mostrar hijos cuando el padre está oculto.
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
  product_type: ProductType | null;
  packaging__id: string | null;
  packaging__name: string | null;
  packaging__value: string | number | null;
  packaging__is_auto: boolean | null;
  show_in_pos: boolean;
  created_at: Date | string;
  /** Stock CRUDO en unidad mínima; el post-proceso lo convierte a display. */
  stock: string | number;
  company_id: string;
  prices:
    | {
        id: number | string;
        sale_price: number | string;
        profit: number | string;
        margin: number | string;
      }[]
    | null;
}

@Injectable()
export class GetItemsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<PosItem[]> {
    // FASE 2: WHERE de visibilidad = propios + compartidos (predicado reusable).
    const accessPred = accessibleProductsPredicate('p', companyId, 1);
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
        p.product_type  AS product_type,
        p.show_in_pos   AS show_in_pos,
        p.created_at    AS created_at,
        p.stock         AS stock,
        p.company_id    AS company_id,
        pk.id           AS packaging__id,
        pk.name         AS packaging__name,
        pk.value        AS packaging__value,
        pk.is_auto      AS packaging__is_auto,
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
      WHERE ${accessPred.sql} AND p.is_archived = false
    `;

    const rows = await this.dataSource.query<RawPosItemRow[]>(sql, [...accessPred.params]);

    const normalized = rows.map((p) => ({
      id: Number(p.id),
      name: p.name,
      cost: Number(p.cost),
      bar_code: p.bar_code ?? '',
      sku_code: p.sku_code ?? '',
      parent_id: p.parent_id ? Number(p.parent_id) : null,
      packaging_id: p.packaging_id ? Number(p.packaging_id) : null,
      // Fallback a SIMPLE: la columna es NOT NULL con default, pero el mapeo
      // no debe romperse si la fila llega de un dump antiguo.
      product_type: p.product_type ?? ProductType.SIMPLE,
      packaging:
        p.packaging__id !== null
          ? {
              id: Number(p.packaging__id),
              name: p.packaging__name as string,
              value: Number(p.packaging__value),
              // Los empaques "auto" (peso/monto variable) tienen nombre UUID
              // interno: el POS necesita la bandera para mostrar una etiqueta
              // genérica en vez del UUID.
              is_auto: p.packaging__is_auto === true,
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
      // Stock CRUDO (unidad mínima). El display se calcula abajo, cuando ya
      // se conoce la relación padre/hijo y la receta de los combos.
      stock: Number(p.stock),
      owner_company_id: Number(p.company_id),
      is_shared: Number(p.company_id) !== companyId,
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

    // Recetas de los combos VISIBLES: sin ellas su stock saldría 0, que no es
    // "dato ausente" sino dato falso (el inventario mostraría otra cifra).
    // Sin combos no cuesta ni una query.
    const recipeByCombo = await loadComboRecipes(
      this.dataSource.manager,
      orderedParents
        .filter((p) => p.show_in_pos && p.product_type === ProductType.COMBO)
        .map((p) => ({ id: p.id, owner_company_id: p.owner_company_id })),
      companyId,
    );

    const items: PosItem[] = [];
    for (const parent of orderedParents) {
      const children = (childrenByParent.get(parent.id) ?? []).map((child) => {
        return {
          id: child.id,
          name: child.name,
          cost: child.cost,
          bar_code: child.bar_code,
          sku_code: child.sku_code,
          parent_id: child.parent_id,
          packaging_id: child.packaging_id,
          product_type: child.product_type,
          packaging: child.packaging,
          prices: child.prices,
          // Presentación: su disponibilidad sale del stock del PADRE dividido
          // por SU propio packaging_value (el hijo no tiene stock propio).
          stock: computeChildStockDisplay(
            parent.stock,
            child.stock,
            child.packaging?.value ?? null,
          ),
          parent: {
            id: parent.id,
            name: parent.name,
            stock: parent.stock,
            cost: parent.cost,
          },
          is_shared: child.is_shared,
          owner_company_id: child.owner_company_id,
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
          product_type: parent.product_type,
          packaging: parent.packaging,
          prices: parent.prices,
          // Un COMBO no tiene stock propio: su disponibilidad son las unidades
          // armables con la receta. El resto usa stock / packaging.value.
          stock:
            parent.product_type === ProductType.COMBO
              ? comboStockFromComponents(recipeByCombo.get(parent.id) ?? [])
              : computeStockDisplay(parent.stock, parent.packaging?.value ?? null),
          parent: null,
          is_shared: parent.is_shared,
          owner_company_id: parent.owner_company_id,
        });
      }
      items.push(...children);
    }

    return items;
  }
}
