import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { PurchaseCredit } from '../entities/purchase-credit.entity';
import { PurchaseLine } from '../entities/purchase-line.entity';
import { PurchasePayment } from '../entities/purchase-payment.entity';
import { Purchase } from '../entities/purchase.entity';
import {
  findPurchaseCredit,
  findPurchaseInCompany,
  findPurchaseLines,
  findPurchasePayments,
} from '../internal/purchase-lookups';

/**
 * Resultado completo del detalle de una compra (cabecera + líneas + credit +
 * pagos). Espejo PlacePos `loadFullPurchase`.
 */
export interface PurchaseAggregate {
  purchase: Purchase;
  lines: PurchaseLine[];
  credit: PurchaseCredit | null;
  payments: PurchasePayment[];
}

/**
 * Lee el detalle completo de una compra por id, dentro de la company.
 *
 * Anti-IDOR:
 *   - El `findPurchaseInCompany` exige `company_id = $current` con
 *     `requireActive: true` (filtra `is_deleted = false`). Si el id existe
 *     en otra company → 404 indistinguible de "no existe".
 *
 * N+1 mitigation:
 *   - Las líneas, credit y payments se cargan en 3 queries explícitas
 *     filtradas por `purchase_id`. Cada una usa un índice dedicado:
 *       - `idx_purchase_lines_purchase_id`
 *       - `idx_purchase_credits_company_purchase_unique`
 *       - `idx_purchase_payments_purchase_id`
 *     Total: 4 round-trips. No N+1.
 */
@Injectable()
export class FindPurchaseAction {
  constructor(
    @InjectRepository(Purchase)
    private readonly repo: Repository<Purchase>,
  ) {}

  async execute(id: number, companyId: number): Promise<PurchaseAggregate> {
    const manager = this.repo.manager;
    const purchase = await findPurchaseInCompany(manager, id, companyId, {
      requireActive: true,
    });
    const lines = await findPurchaseLines(manager, Number(purchase.id), companyId);
    const credit = await findPurchaseCredit(manager, Number(purchase.id), companyId);
    const payments = await findPurchasePayments(manager, Number(purchase.id), companyId);

    return { purchase, lines, credit, payments };
  }
}
