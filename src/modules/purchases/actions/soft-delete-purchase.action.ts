import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import { Purchase } from '../entities/purchase.entity';
import { findPurchaseCredit, findPurchaseInCompany } from '../internal/purchase-lookups';

/**
 * Soft-delete (anulación) de una compra. Espejo del comportamiento PlacePos:
 * NO existe un `DELETE /purchases/:id` formal en `purchases.routes.ts`, pero
 * el frontend cloud necesita un endpoint para anular pedidos PENDING sin
 * pagos. Lo añadimos como extensión backwards-compatible (CLAUDE.md §6 —
 * añadir campos/endpoints opt-in no rompe paridad).
 *
 * --------------------------------------------------------------------------
 * Reglas (defensivas, antes del UPDATE)
 * --------------------------------------------------------------------------
 *
 *   - La compra debe existir en la company y no estar ya anulada.
 *   - El `PurchaseCredit` asociado debe tener `paid_amount = 0`. Anular una
 *     compra con pagos aplicados es un descuadre contable —se rechaza con
 *     422 (mensaje legible). La reversión correcta de pagos vive en otro
 *     flujo (no en esta fase).
 *
 * --------------------------------------------------------------------------
 * Side effects al anular
 * --------------------------------------------------------------------------
 *
 *   - Decrementa `Supplier.accumulated_debt` por el `purchase.total` (la
 *     deuda dejó de existir).
 *   - Marca `purchase.is_deleted = true`.
 *   - El `PurchaseCredit` queda con balance > 0 pero su compra is_deleted —
 *     los queries de listado lo excluyen.
 */
@Injectable()
export class SoftDeletePurchaseAction {
  private readonly logger = new Logger(SoftDeletePurchaseAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, actorId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const purchase = await findPurchaseInCompany(manager, id, companyId, {
        requireActive: true,
      });

      const credit = await findPurchaseCredit(manager, id, companyId);
      if (credit && toBig(credit.paid_amount).gt(0)) {
        throw new UnprocessableEntityException('No se puede anular una compra con pagos aplicados');
      }

      const totalBig: Big = toBig(purchase.total);
      const supplierId = purchase.supplier_id;

      await manager.update(
        Purchase,
        { id: purchase.id, company_id: String(companyId) },
        { is_deleted: true },
      );

      // Revertir la deuda acumulada (la compra ya no cuenta).
      if (totalBig.gt(0)) {
        await manager.decrement(
          Supplier,
          { id: supplierId, company_id: String(companyId) },
          'accumulated_debt',
          totalBig.toNumber(),
        );
      }

      this.logger.log({
        event: 'purchase.soft_deleted',
        companyId,
        purchaseId: id,
        actorId,
        revertedDebt: totalBig.toFixed(2),
      });
    });
  }
}
