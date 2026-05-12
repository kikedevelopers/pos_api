import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { PurchasePayment } from '../entities/purchase-payment.entity';
import { Purchase } from '../entities/purchase.entity';
import { findPurchaseInCompany, findPurchasePayments } from '../internal/purchase-lookups';

/**
 * Lista los pagos de una compra. Endpoint utilitario (PlacePos lo expone
 * indirectamente vía `serializePurchase`, pero el frontend cloud puede
 * querer paginar/refrescar solo la lista).
 *
 * Pre-valida tenancy de la compra (`findPurchaseInCompany`); sin eso, un id
 * de otra company devolvería `[]` indistinguible de una compra sin pagos.
 */
@Injectable()
export class ListPurchasePaymentsAction {
  constructor(
    @InjectRepository(Purchase)
    private readonly repo: Repository<Purchase>,
  ) {}

  async execute(purchaseId: number, companyId: number): Promise<PurchasePayment[]> {
    const manager = this.repo.manager;
    await findPurchaseInCompany(manager, purchaseId, companyId);
    return findPurchasePayments(manager, purchaseId, companyId);
  }
}
