import { Injectable } from '@nestjs/common';

import { FindCostHistoryAction, type CostHistoryItem } from './actions/find-cost-history.action';
import { FindPriceHistoryAction, type PriceHistoryItem } from './actions/find-price-history.action';

export type { CostHistoryItem } from './actions/find-cost-history.action';
export type { PriceHistoryItem } from './actions/find-price-history.action';

/**
 * Facade del módulo `product-history`. Solo delega.
 */
@Injectable()
export class ProductHistoryService {
  constructor(
    private readonly findCostHistoryAction: FindCostHistoryAction,
    private readonly findPriceHistoryAction: FindPriceHistoryAction,
  ) {}

  findCostHistory(
    productId: number,
    companyId: number,
    limit?: number,
  ): Promise<CostHistoryItem[]> {
    return this.findCostHistoryAction.execute(productId, companyId, limit);
  }

  findPriceHistory(
    productPriceId: number,
    companyId: number,
    limit?: number,
  ): Promise<PriceHistoryItem[]> {
    return this.findPriceHistoryAction.execute(productPriceId, companyId, limit);
  }
}
