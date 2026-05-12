import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import { PurchaseCredit } from '../entities/purchase-credit.entity';
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
 *     compra con pagos aplicados es un descuadre contable — se rechaza con
 *     422. La reversión correcta de pagos vive en otro flujo (no en esta
 *     fase).
 *
 * --------------------------------------------------------------------------
 * Side effects al anular
 * --------------------------------------------------------------------------
 *
 *   - Decrementa `Supplier.accumulated_debt` por el **balance pendiente** del
 *     credit (no por `purchase.total`). HIGH-1 auditoría: si en el futuro la
 *     guarda anti-pagos fallara o se relajara, decrementar por el total
 *     descuadraría el `accumulated_debt`. Usar `credit.balance` es defensivo
 *     y robusto a inconsistencias.
 *   - **Hard-delete del `PurchaseCredit`** asociado (CRIT-3 auditoría). Si lo
 *     dejamos huérfano, queries downstream de cuentas-por-pagar lo seguirán
 *     mostrando como pendiente. Como la compra ya está anulada y la guarda
 *     impide pagos previos, el credit no tiene historia útil que preservar.
 *   - Marca `purchase.is_deleted = true`.
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

      // HIGH-1 auditoría: el monto a revertir es el saldo pendiente, no el
      // total. La guarda anterior garantiza `paid_amount = 0`, así que en la
      // práctica `credit.balance = purchase.total`, pero usar el balance nos
      // blinda contra futuras relajaciones de la guarda.
      const debtToRevert: Big = credit ? toBig(credit.balance) : toBig(purchase.total);
      const supplierId = purchase.supplier_id;

      await manager.update(
        Purchase,
        { id: purchase.id, company_id: String(companyId) },
        { is_deleted: true },
      );

      // CRIT-3 auditoría: hard-delete del credit huérfano. Sin esto, las
      // queries de cuentas por pagar seguirían mostrando el credit como
      // pendiente aunque la compra esté anulada. Como la guarda impide pagos
      // previos, no hay historia financiera que preservar — solo metadata
      // que ya está en la propia compra (is_deleted=true).
      if (credit) {
        await manager.delete(PurchaseCredit, {
          id: credit.id,
          company_id: String(companyId),
        });
      }

      // Revertir la deuda acumulada (la compra ya no cuenta).
      if (debtToRevert.gt(0)) {
        await manager.decrement(
          Supplier,
          { id: supplierId, company_id: String(companyId) },
          'accumulated_debt',
          debtToRevert.toNumber(),
        );
      }

      this.logger.log({
        event: 'purchase.soft_deleted',
        companyId,
        purchaseId: id,
        actorId,
        revertedDebt: debtToRevert.toFixed(2),
        creditDeleted: credit !== null,
      });
    });
  }
}
