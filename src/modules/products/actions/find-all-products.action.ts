import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type Repository, Brackets } from 'typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import type { InventoryQueryDto } from '../dto/inventory-query.dto';

/**
 * Lista productos de una company. Endpoint `GET /inventory`.
 *
 * Comportamiento paridad-PlacePos:
 *   1. Filtra `is_archived = false` por defecto. Si query trae
 *      `include_archived=true`, se incluyen.
 *   2. Carga `prices` y `packaging` (relations).
 *   3. Ordena por:
 *      - Padres primero (parent_id IS NULL),
 *      - Cada padre seguido de sus hijos,
 *      - Dentro de cada grupo, ORDER BY `created_at DESC`.
 *      (Replicamos `placepos/inventory.routes.ts` línea 280-300.)
 *   4. Si `search` está presente, filtra case-insensitive contra
 *      `name`, `sku_code`, `bar_code`. Extensión opt-in (PlacePos no la
 *      tiene pero el frontend la ignora si no se envía).
 *
 * Read puro — no requiere transacción.
 *
 * N+1: usamos `relations: { prices, packaging }` en lugar de un
 * `createQueryBuilder` con joins explícitos. TypeORM emite 1 query por
 * relation con `IN (...)` — eficiente para catálogos típicos. Si el
 * catálogo crece a >10k items, conviene migrar a leftJoinAndSelect.
 */
@Injectable()
export class FindAllProductsAction {
  constructor(
    @InjectRepository(Product)
    private readonly repo: Repository<Product>,
  ) {}

  async execute(companyId: number, query: InventoryQueryDto): Promise<Product[]> {
    const qb = this.repo
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.prices', 'pp')
      .leftJoinAndSelect('p.packaging', 'pk')
      .leftJoinAndSelect('p.category', 'cat')
      .where('p.company_id = :companyId', { companyId: String(companyId) });

    if (query.include_archived !== true) {
      qb.andWhere('p.is_archived = false');
    }

    if (query.search && query.search.trim().length > 0) {
      const search = `%${query.search.trim().toLowerCase()}%`;
      qb.andWhere(
        new Brackets((b) => {
          b.where('LOWER(p.name) LIKE :search', { search })
            .orWhere('LOWER(p.sku_code) LIKE :search', { search })
            .orWhere('LOWER(p.bar_code) LIKE :search', { search });
        }),
      );
    }

    // Cargamos todo y ordenamos en memoria — necesitamos el árbol
    // parent/child que SQL puro ordenaría con CTE recursivo. Para los
    // tamaños esperados (cientos a miles), JS es más rápido que un
    // recursive query.
    qb.orderBy('p.created_at', 'DESC');

    const products = await qb.getMany();

    return sortParentsThenChildren(products);
  }
}

/**
 * Ordena: padres primero (por `created_at DESC`), seguidos de sus hijos
 * (también `created_at DESC`). Espejo de PlacePos.
 *
 * Exportada para tests unitarios.
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
