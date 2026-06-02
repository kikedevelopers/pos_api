import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import Big from 'big.js';
import { DataSource, type EntityManager } from 'typeorm';

import { recordInventoryMovement } from '@/modules/products/internal/adjust-inventory.helper';
import { Product } from '@/modules/products/entities/product.entity';
import { ProductCostHistoryEvent } from '@/modules/product-history/entities/product-cost-history.entity';

import type { ReceivePurchaseDto } from '../dto/receive-purchase.dto';
import { PurchaseLine } from '../entities/purchase-line.entity';
import { Purchase, PurchaseStatus } from '../entities/purchase.entity';
import {
  findPurchaseCredit,
  findPurchaseInCompany,
  findPurchaseLines,
  findPurchasePayments,
} from '../internal/purchase-lookups';
import { recalculateProductCosts } from '../internal/recalculate-product-costs.helper';
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
 * Carga de inventario
 * --------------------------------------------------------------------------
 *
 * Espejo de `receivePurchase` de PlacePos: por cada línea, suma `unit_qty`
 * al stock del producto e inserta una fila de auditoría en
 * `inventory_movements` con reason=PURCHASE_RECEIVE. El lock pessimistic_write
 * sobre los productos serializa receptions concurrentes sobre el mismo
 * producto (un raro pero posible escenario de doble-click).
 *
 * `unit_qty` está pre-calculado por el cliente (packaging_qty *
 * packaging_value cuando hay empaque). Aquí lo sumamos directamente —
 * paridad con `computeStockDelta` de PlacePos.
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

      // Paridad placepos: el cliente envía `received_at` (fecha que el
      // usuario eligió en el modal, materializada a 12:00 locales). Si no
      // llega, usamos `now()`. El `carrier_name` ya está persistido desde el
      // create — no se sobreescribe en el receive (el cliente actual no lo
      // envía y la entity conserva el snapshot original).
      const receivedAt =
        dto.received_at !== undefined && dto.received_at !== null
          ? new Date(dto.received_at)
          : new Date();
      await manager.update(
        Purchase,
        { id: String(id), company_id: String(companyId) },
        {
          status: PurchaseStatus.RECEIVED,
          received_by: dto.received_by.trim(),
          received_at: receivedAt,
        },
      );

      // Cargar líneas y aplicar el incremento de stock con auditoría.
      const purchaseLines = await manager.find(PurchaseLine, {
        where: { purchase_id: String(id), company_id: String(companyId) },
      });

      // IMPORTANTE: el recálculo de costos (promedio ponderado con flete) debe
      // correr ANTES del increment del stock, para que el `stockBefore` que usa
      // la fórmula sea el stock previo a esta compra (lee Product.stock actual).
      // Paridad placepos `receivePurchase`.
      await recalculateProductCosts(manager, purchaseLines, {
        eventType: ProductCostHistoryEvent.RECEIVE,
        purchaseId: id,
        companyId,
        transportCost: Number(purchase.transport_cost),
        actor: { id: actorId, fullName: dto.received_by.trim() },
      });

      await this.applyStockIncrements(
        manager,
        companyId,
        id,
        purchase.purchase_number,
        purchaseLines,
        actorId,
        dto.received_by.trim(),
      );

      this.logger.log({
        event: 'purchase.received',
        companyId,
        purchaseId: id,
        actorId,
        carrierName: purchase.carrier_name,
        receivedBy: dto.received_by,
        lineCount: purchaseLines.length,
      });

      // Releer el aggregate.
      const refreshed = await findPurchaseInCompany(manager, id, companyId);
      const lines = await findPurchaseLines(manager, id, companyId);
      const credit = await findPurchaseCredit(manager, id, companyId);
      const payments = await findPurchasePayments(manager, id, companyId);
      return { purchase: refreshed, lines, credit, payments };
    });
  }

  /**
   * Aplica el incremento de stock por línea. Lockea cada producto destino
   * con pessimistic_write (ordenado ASC para evitar deadlock) y persiste
   * una fila en `inventory_movements` por producto afectado.
   *
   * El delta se acumula por producto — si la compra tiene varias líneas con
   * el mismo product_id (raro pero posible), se suman antes de actualizar.
   */
  private async applyStockIncrements(
    manager: EntityManager,
    companyId: number,
    purchaseId: number,
    purchaseNumber: string,
    lines: PurchaseLine[],
    actorId: number,
    actorName: string,
  ): Promise<void> {
    if (lines.length === 0) {
      return;
    }

    // Acumular delta por product_id.
    const deltas = new Map<string, Big>();
    for (const line of lines) {
      const qty = new Big(Number(line.unit_qty));
      if (qty.lte(0)) {
        continue;
      }
      const current = deltas.get(line.product_id) ?? new Big(0);
      deltas.set(line.product_id, current.plus(qty));
    }
    if (deltas.size === 0) {
      return;
    }

    // Lock pessimistic_write en orden ASC (anti-deadlock).
    const sortedIds = Array.from(deltas.keys()).sort((a, b) => Number(a) - Number(b));

    const locked = await manager
      .getRepository(Product)
      .createQueryBuilder('p')
      .setLock('pessimistic_write')
      .where('p.id IN (:...ids) AND p.company_id = :companyId', {
        ids: sortedIds,
        companyId: String(companyId),
      })
      .orderBy('p.id', 'ASC')
      .select(['p.id', 'p.stock', 'p.name'])
      .getMany();

    if (locked.length !== sortedIds.length) {
      throw new UnprocessableEntityException(
        'Una o más líneas referencian productos que ya no existen en la company',
      );
    }

    for (const product of locked) {
      const delta = deltas.get(product.id);
      if (!delta || delta.lte(0)) {
        continue;
      }
      const stockBefore = new Big(Number(product.stock));
      const stockAfter = stockBefore.plus(delta).round(4, Big.roundHalfUp);
      await manager.update(
        Product,
        { id: product.id, company_id: String(companyId) },
        { stock: stockAfter.toNumber() },
      );
      await recordInventoryMovement(manager, {
        companyId,
        productId: Number(product.id),
        direction: 'IN',
        quantity: delta.round(4, Big.roundHalfUp).toNumber(),
        stockBefore: stockBefore.toNumber(),
        stockAfter: stockAfter.toNumber(),
        reason: 'PURCHASE_RECEIVE',
        referenceType: 'purchase',
        referenceId: purchaseId,
        referenceCode: purchaseNumber,
        description: `Recepción compra ${purchaseNumber}`,
        createdBy: actorName,
        createdById: actorId,
      });
    }
  }
}
