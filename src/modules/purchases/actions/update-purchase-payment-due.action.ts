import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { UpdatePurchasePaymentDueDto } from '../dto/update-purchase-payment-due.dto';
import { PurchaseCreditStatus } from '../entities/purchase-credit.entity';
import { Purchase } from '../entities/purchase.entity';
import { translatePurchaseConstraintError } from '../internal/constraint-errors';
import { resolvePaymentDueAt } from '../internal/payment-due';
import { findPurchaseCredit, findPurchaseInCompany } from '../internal/purchase-lookups';
import { FindPurchaseAction, type PurchaseAggregate } from './find-purchase.action';

/**
 * Cambia o quita el plazo de pago de una compra (`PATCH /purchases/:id/payment-due`).
 *
 * Reglas:
 *   - La compra debe ser de la company y estar activa (anulada → 404).
 *   - El nuevo día no puede ser anterior a hoy (Bogotá); vence al final del día.
 *   - Una compra YA PAGADA no admite un plazo nuevo (no hay nada que vencer);
 *     sí se le puede quitar (`null`).
 *   - Solo toca `payment_due_at`: ni líneas, ni totales, ni inventario, ni deuda.
 *
 * Devuelve el agregado completo para que el visor se refresque sin otro GET.
 */
@Injectable()
export class UpdatePurchasePaymentDueAction {
  constructor(
    @InjectRepository(Purchase)
    private readonly repo: Repository<Purchase>,
    private readonly findPurchaseAction: FindPurchaseAction,
  ) {}

  async execute(
    id: number,
    dto: UpdatePurchasePaymentDueDto,
    companyId: number,
  ): Promise<PurchaseAggregate> {
    const paymentDueAt = resolvePaymentDueAt(dto.payment_due_date);

    const manager = this.repo.manager;
    const purchase = await findPurchaseInCompany(manager, id, companyId, { requireActive: true });

    if (paymentDueAt !== null) {
      const credit = await findPurchaseCredit(manager, Number(purchase.id), companyId);
      if (credit?.status === PurchaseCreditStatus.PAID) {
        throw new UnprocessableEntityException(
          'La compra ya está pagada: no necesita plazo de pago',
        );
      }
    }

    try {
      await manager.update(
        Purchase,
        { id: purchase.id, company_id: String(companyId) },
        { payment_due_at: paymentDueAt },
      );
    } catch (error) {
      translatePurchaseConstraintError(error);
      throw error;
    }

    return this.findPurchaseAction.execute(id, companyId);
  }
}
