import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Product } from '@/modules/products/entities/product.entity';

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
@Injectable()
export class GetItemsAction {
  constructor(
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
  ) {}

  async execute(companyId: number): Promise<PosItem[]> {
    const products = await this.productRepo.find({
      where: { company_id: String(companyId), is_archived: false },
      relations: { prices: true, packaging: true },
    });

    const normalized = products.map((p) => ({
      id: Number(p.id),
      name: p.name,
      cost: Number(p.cost),
      bar_code: p.bar_code ?? '',
      sku_code: p.sku_code ?? '',
      parent_id: p.parent_id ? Number(p.parent_id) : null,
      packaging_id: p.packaging_id ? Number(p.packaging_id) : null,
      packaging: p.packaging
        ? {
            id: Number(p.packaging.id),
            name: p.packaging.name,
            value: Number(p.packaging.value),
          }
        : null,
      show_in_pos: p.show_in_pos,
      created_at: p.created_at,
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
