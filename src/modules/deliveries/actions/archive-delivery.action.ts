import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Delivery } from '../entities/delivery.entity';
import { reverseCashForDelivery, type DeliveryActor } from '../internal/delivery-cash.helper';
import { findDeliveryInCompany } from '../internal/delivery-lookups';

/**
 * Archiva un domicilio (`PUT /deliveries/:id/archive`).
 *
 * --------------------------------------------------------------------------
 * Pasos atómicos
 * --------------------------------------------------------------------------
 *
 *   1. Cargar el domicilio en el tenant. Rechaza si ya está archivado
 *      (idempotencia inversa: no revertir el egreso dos veces).
 *   2. Si fue `payment_method === 'cash_register'` y tiene
 *      `cash_register_log_id`: revierte el egreso → ingreso a la caja ORIGINAL
 *      + INSERT CashRegisterLog(VOID_DELIVERY_PAYMENT, IN). Si fue
 *      `on_delivery`: NO toca caja.
 *   3. UPDATE Delivery SET is_archived = true.
 *
 * Si CUALQUIER paso falla → rollback total.
 *
 * Aislamiento `READ COMMITTED` + lock `pessimistic_write` sobre la caja (igual
 * que la creación). Ese lock es EXCLUSIVO del backend cloud — el cliente
 * offline no bloquea la fila de caja (concurrencia single-process). La paridad
 * con el offline es de SEMÁNTICA (mismo ingreso de reversión, mismo log), no
 * de mecanismo de locking.
 *
 * Multi-tenancy: `findDeliveryInCompany` valida el tenant; la caja se
 * re-valida dentro del tenant en `reverseCashForDelivery`.
 */
@Injectable()
export class ArchiveDeliveryAction {
  private readonly logger = new Logger(ArchiveDeliveryAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, actor: DeliveryActor): Promise<{ archived: true }> {
    await this.dataSource.transaction(async (manager) => {
      const delivery = await findDeliveryInCompany(manager, id, companyId);
      if (delivery.is_archived) {
        throw new UnprocessableEntityException('El domicilio ya fue anulado');
      }

      // Revertir el egreso de caja si aplica. El monto se toma del log de
      // caja original (dentro del helper), no de `delivery.amount`.
      if (delivery.payment_method === 'cash_register' && delivery.cash_register_log_id !== null) {
        await reverseCashForDelivery(
          manager,
          companyId,
          Number(delivery.cash_register_log_id),
          delivery.delivery_company_name,
          actor,
        );
      }

      await manager.update(
        Delivery,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );

      this.logger.log({
        event: 'delivery.archived',
        companyId,
        deliveryId: id,
        paymentMethod: delivery.payment_method,
        reversedCash:
          delivery.payment_method === 'cash_register' && delivery.cash_register_log_id !== null,
        actorId: actor.id,
      });
    });

    return { archived: true };
  }
}
