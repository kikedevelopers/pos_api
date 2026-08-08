import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { calculateMargin, calculateProfit } from '@/common/utils/precision';
import { normalizeNameSql } from '@/modules/categories/internal/category-lookups';

import { ComboComponent } from '../entities/combo-component.entity';
import { Product, ProductType } from '../entities/product.entity';
import { ProductPrice } from '../entities/product-price.entity';
import {
  type ComboComponentInput,
  comboCostFromComponents,
  resolveComboComponents,
  syncComboComponents,
} from '../internal/combo-components.helper';
import { translateProductConstraintError } from '../internal/constraint-errors';
import { resolveCopyName } from '../internal/product-copy-name';
import { findProductInCompany } from '../internal/product-lookups';

import type { ProductCreator } from './create-product.action';

/**
 * Duplica un producto del catálogo. Endpoint `POST /inventory/:id/duplicate`.
 * Espejo de la ruta homónima de PlacePos (`inventory.routes.ts`).
 *
 * --------------------------------------------------------------------------
 * Qué se copia y qué no
 * --------------------------------------------------------------------------
 *
 * Se hereda TODO lo del original: costo, niveles de precio (con su nombre e
 * IVA), categoría, empaque, descripción, imagen, visibilidad en POS, comprable
 * y —si es un COMBO— su receta. Quedan fuera tres cosas:
 *
 *   - `sku_code` y `bar_code`: son ÚNICOS por company. La copia nace sin ellos.
 *   - `stock`: arranca en 0. La copia es una referencia nueva; heredar
 *     existencias inflaría la valorización del inventario sin una compra que
 *     las respalde.
 *
 * Una PRESENTACIÓN se duplica anclada al MISMO producto base que el original
 * (se copia su `parent_id`), así la copia sigue derivando stock del mismo base.
 *
 * --------------------------------------------------------------------------
 * Nombre de la copia
 * --------------------------------------------------------------------------
 *
 * `<NOMBRE> COPIA`, numerado si ya existe (`COPIA 2`, `COPIA 3`…). Ver
 * `internal/product-copy-name.ts` — es el mismo algoritmo que PlacePos, para
 * que el POS produzca el mismo nombre en local y en cloud.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy
 * --------------------------------------------------------------------------
 *
 * El origen se resuelve con `findProductInCompany`: solo se duplica un producto
 * PROPIO. Un producto COMPARTIDO por el negocio principal vive en otra company
 * y no es duplicable desde la sucursal (404) — igual que editarlo o archivarlo.
 *
 * Transacción: alta del producto + precios + receta son atómicos.
 */
@Injectable()
export class DuplicateProductAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, actor: ProductCreator): Promise<Product> {
    return this.dataSource.transaction<Product>(async (manager) => {
      const source = await findProductInCompany(manager, id, companyId);

      const name = await resolveCopyName(source.name, (candidate) =>
        isProductNameTaken(manager, companyId, candidate),
      );

      const isCombo = source.product_type === ProductType.COMBO;
      // La receta se RE-RESUELVE contra la BD en vez de copiar los costos
      // congelados: así la copia nace con el costo derivado vigente y se
      // revalidan las reglas del combo (componente archivado, etc.).
      const components = isCombo
        ? await resolveComboComponents(
            manager,
            companyId,
            null,
            await loadComboRecipeInputs(manager, companyId, Number(source.id)),
          )
        : null;
      const cost = components ? comboCostFromComponents(components) : Number(source.cost);

      const copy = manager.create(Product, {
        company_id: String(companyId),
        name,
        description: source.description,
        product_type: source.product_type,
        parent_id: source.parent_id,
        sku_code: null,
        bar_code: null,
        packaging_id: source.packaging_id,
        category_id: source.category_id,
        cost,
        stock: 0,
        image: source.image,
        show_in_pos: source.show_in_pos,
        is_purchasable: source.is_purchasable,
        is_archived: false,
        // `hash` lo genera el CLIENTE a partir de nombre/códigos/stock/precios;
        // pos_api nunca lo calcula. El del original ya no describe a la copia
        // (cambian nombre y stock), así que se deja en null en vez de arrastrar
        // un hash mentiroso.
        hash: null,
        // Linaje de sucursal: si el original era una copia clonada del
        // principal, su duplicado desciende de la misma company de origen.
        cloned_from_company_id: source.cloned_from_company_id,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      });

      let saved: Product;
      try {
        saved = await manager.save(Product, copy);
      } catch (error) {
        translateProductConstraintError(error);
        throw error;
      }

      if (components) {
        await syncComboComponents(manager, companyId, Number(saved.id), components);
      }

      // Los niveles de precio se copian en el mismo orden en que los pinta el
      // formulario (orden de creación). profit/margin se RECALCULAN con Big.js
      // contra el costo de la copia: son derivados de (sale_price, cost), nunca
      // un dato propio que haya que arrastrar.
      const prices = await manager.find(ProductPrice, {
        where: { company_id: String(companyId), product_id: source.id },
        order: { id: 'ASC' },
      });
      if (prices.length > 0) {
        await manager.insert(
          ProductPrice,
          prices.map((price) => ({
            company_id: String(companyId),
            product_id: saved.id,
            name: price.name,
            sale_price: price.sale_price,
            profit: calculateProfit(price.sale_price, cost),
            margin: calculateMargin(price.sale_price, cost),
            iva_percentage: price.iva_percentage,
            created_by: actor.fullName,
            created_by_id: String(actor.id),
          })),
        );
      }

      return saved;
    });
  }
}

/**
 * ¿Existe ya un producto con este nombre en la company? La comparación ignora
 * mayúsculas y acentos (misma normalización que el resto del módulo) y NO
 * filtra archivados: aunque el índice único parcial solo cubre activos,
 * reutilizar el nombre de un archivado confundiría al usuario y divergiría del
 * nombre que genera PlacePos (donde el UNIQUE de `products.name` es global).
 */
async function isProductNameTaken(
  manager: EntityManager,
  companyId: number,
  name: string,
): Promise<boolean> {
  const found = await manager
    .getRepository(Product)
    .createQueryBuilder('p')
    .select('p.id')
    .where('p.company_id = :cid', { cid: String(companyId) })
    .andWhere(`${normalizeNameSql('p.name')} = ${normalizeNameSql(':name')}`, { name })
    .limit(1)
    .getOne();
  return found !== null;
}

/**
 * Receta persistida de un combo, en la forma que espera `resolveComboComponents`.
 * Se leen las filas CRUDAS (no `loadComboComponentsByCombo`, que omite en
 * silencio los componentes archivados): si la receta ya no es válida queremos el
 * error explícito, no una copia con menos ingredientes que el original.
 */
async function loadComboRecipeInputs(
  manager: EntityManager,
  companyId: number,
  comboId: number,
): Promise<ComboComponentInput[]> {
  const rows = await manager.find(ComboComponent, {
    where: { company_id: String(companyId), combo_product_id: String(comboId) },
    order: { id: 'ASC' },
  });
  return rows.map((row) => ({
    component_product_id: Number(row.component_product_id),
    quantity: Number(row.quantity),
  }));
}
