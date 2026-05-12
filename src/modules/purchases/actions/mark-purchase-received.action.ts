import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { ReceivePurchaseDto } from '../dto/receive-purchase.dto';
import { Purchase, PurchaseStatus } from '../entities/purchase.entity';
import {
  findPurchaseCredit,
  findPurchaseInCompany,
  findPurchaseLines,
  findPurchasePayments,
} from '../internal/purchase-lookups';
import type { PurchaseAggregate } from './find-purchase.action';

/**
 * Marca una compra como `RECEIVED`. Espejo PlacePos `PUT /purchases/:id/receive`.
 *
 * --------------------------------------------------------------------------
 * Reglas
 * --------------------------------------------------------------------------
 *
 *   - La compra debe existir en la company y no estar anulada (`is_deleted = false`).
 *   - La compra debe estar en estado `PENDING`. Recibir una ya `RECEIVED`
 *     → 422 con mensaje legible (idempotencia naive: PlacePos también
 *     rechaza la doble recepción).
 *
 * --------------------------------------------------------------------------
 * TODO(Fase 3 actualizada o Fase 8.5): Carga de inventario al recibir
 * --------------------------------------------------------------------------
 *
 *   PlacePos en `receivePurchase` hace `manager.increment(Product, {id}, 'stock', unit_qty)`
 *   por cada línea de la compra. La columna `Product.stock` AÚN no existe
 *   en este API (Fase 3 la omitió a propósito y dejó la incorporación
 *   pendiente — comentario en `Product.entity.ts`).
 *
 *   Cuando se añada `Product.stock`, esta action debe hacer el increment
 *   atómicamente DENTRO de la transacción que cambia el status a RECEIVED.
 *
 *   Mientras tanto, recibir solo registra metadata (transportadora, receptor,
 *   timestamp). Esto es suficiente para que el frontend muestre el estado
 *   correcto y respete el contrato HTTP.
 */
@Injectable()
export class MarkPurchaseReceivedAction {
  private readonly logger = new Logger(MarkPurchaseReceivedAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    id: number,
    dto: ReceivePurchaseDto,
    companyId: number,
    actorId: number,
  ): Promise<PurchaseAggregate> {
    return this.dataSource.transaction<PurchaseAggregate>(async (manager) => {
      const purchase = await findPurchaseInCompany(manager, id, companyId, {
        requireActive: true,
      });

      if (purchase.status === PurchaseStatus.RECEIVED) {
        throw new UnprocessableEntityException('La compra ya fue recibida');
      }

      const receivedAt = new Date();
      await manager.update(
        Purchase,
        { id: String(id), company_id: String(companyId) },
        {
          status: PurchaseStatus.RECEIVED,
          carrier_name: dto.carrier_name.trim(),
          received_by: dto.received_by.trim(),
          received_at: receivedAt,
        },
      );

      // TODO(stock): increment Product.stock por línea cuando la columna exista.
      //   const lines = await findPurchaseLines(manager, id, companyId);
      //   for (const line of lines) {
      //     await manager.increment(
      //       Product,
      //       { id: line.product_id, company_id: String(companyId) },
      //       'stock',
      //       line.unit_qty,
      //     );
      //   }

      this.logger.log({
        event: 'purchase.received',
        companyId,
        purchaseId: id,
        actorId,
        carrierName: dto.carrier_name,
        receivedBy: dto.received_by,
      });

      // Releer el aggregate.
      const refreshed = await findPurchaseInCompany(manager, id, companyId);
      const lines = await findPurchaseLines(manager, id, companyId);
      const credit = await findPurchaseCredit(manager, id, companyId);
      const payments = await findPurchasePayments(manager, id, companyId);
      return { purchase: refreshed, lines, credit, payments };
    });
  }
}
