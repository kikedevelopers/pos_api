import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { ProductCostHistory } from '../entities/product-cost-history.entity';

/**
 * Item del historial enriquecido con `purchase_number` join.
 */
export interface CostHistoryItem {
  entry: ProductCostHistory;
  purchase_number: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Lista el historial de costo de un producto.
 * Endpoint: `GET /products/:id/cost-history?limit=N`.
 *
 * Multi-tenant + lookup por product_id. Sin pre-validar que el producto
 * exista — si no existe, simplemente devuelve []. Anti-enumeración: no
 * distinguimos "producto inexistente" de "producto sin historial".
 *
 * Ordenado por `created_at DESC, id DESC` (tiebreaker para evitar
 * desordenes cuando dos entries comparten timestamp).
 *
 * Fase 2A: la tabla está vacía hasta Fase 5+. El endpoint funciona y
 * devuelve [].
 */
@Injectable()
export class FindCostHistoryAction {
  constructor(
    @InjectRepository(ProductCostHistory)
    private readonly repo: Repository<ProductCostHistory>,
  ) {}

  async execute(productId: number, companyId: number, limit?: number): Promise<CostHistoryItem[]> {
    const normalizedLimit = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const qb = this.repo
      .createQueryBuilder('h')
      .leftJoin('purchases', 'p', 'p.id = h.purchase_id')
      .addSelect('p.purchase_number', 'p_purchase_number')
      .where('h.company_id = :companyId', { companyId: String(companyId) })
      .andWhere('h.product_id = :productId', { productId: String(productId) })
      .orderBy('h.created_at', 'DESC')
      .addOrderBy('h.id', 'DESC')
      .limit(normalizedLimit);

    const { entities, raw } = await qb.getRawAndEntities<ProductCostHistory>();

    return entities.map((entry, idx) => {
      const r = raw[idx] as unknown as Record<string, unknown>;
      return {
        entry,
        purchase_number: (r.p_purchase_number as string | null | undefined) ?? null,
      };
    });
  }
}
