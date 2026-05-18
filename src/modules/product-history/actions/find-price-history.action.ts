import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { ProductCostHistoryEvent } from '../entities/product-cost-history.entity';
import { ProductPriceHistory } from '../entities/product-price-history.entity';

/**
 * Item del historial de precio enriquecido con datos JOIN-eados desde
 * `product_cost_history` (purchase_id, event_type).
 */
export interface PriceHistoryItem {
  entry: ProductPriceHistory;
  purchase_id: number | null;
  event_type: ProductCostHistoryEvent | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Lista el historial de precio de un `product_price`.
 * Endpoint: `GET /product-prices/:id/price-history?limit=N`.
 *
 * JOIN con `product_cost_history` para traer `purchase_id` y `event_type`
 * cuando aplique (cambio de precio derivado de una compra). Si el
 * `cost_history_id` es NULL, devolvemos los campos JOIN como `null`.
 *
 * Multi-tenant siempre. Ordenado por fecha desc.
 */
@Injectable()
export class FindPriceHistoryAction {
  constructor(
    @InjectRepository(ProductPriceHistory)
    private readonly repo: Repository<ProductPriceHistory>,
  ) {}

  async execute(
    productPriceId: number,
    companyId: number,
    limit?: number,
  ): Promise<PriceHistoryItem[]> {
    const normalizedLimit = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const qb = this.repo
      .createQueryBuilder('h')
      .leftJoin('product_cost_history', 'ch', 'ch.id = h.cost_history_id')
      .addSelect('ch.purchase_id', 'ch_purchase_id')
      .addSelect('ch.event_type', 'ch_event_type')
      .where('h.company_id = :companyId', { companyId: String(companyId) })
      .andWhere('h.product_price_id = :priceId', { priceId: String(productPriceId) })
      .orderBy('h.created_at', 'DESC')
      .addOrderBy('h.id', 'DESC')
      .limit(normalizedLimit);

    const { entities, raw } = await qb.getRawAndEntities<ProductPriceHistory>();

    return entities.map((entry, idx) => {
      const r = raw[idx] as unknown as Record<string, unknown>;
      return {
        entry,
        purchase_id:
          r.ch_purchase_id !== null && r.ch_purchase_id !== undefined
            ? Number(r.ch_purchase_id)
            : null,
        event_type: (r.ch_event_type as ProductCostHistoryEvent | null | undefined) ?? null,
      };
    });
  }
}
