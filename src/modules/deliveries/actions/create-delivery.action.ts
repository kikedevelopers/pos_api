import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type Big from 'big.js';
import { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';

import type { CreateDeliveryDto } from '../dto/create-delivery.dto';
import { Delivery } from '../entities/delivery.entity';
import { debitCashForDelivery, type DeliveryActor } from '../internal/delivery-cash.helper';
import { findDeliveryCompanyInCompany } from '../internal/delivery-lookups';

/**
 * Registra un domicilio (`POST /deliveries`).
 *
 * --------------------------------------------------------------------------
 * Pasos atómicos (dentro de `dataSource.transaction`)
 * --------------------------------------------------------------------------
 *
 *   1. Resolver el domiciliario en el tenant (snapshot de su nombre).
 *   2. Resolver (opcional) la venta ligada en el tenant (snapshot del ticket).
 *   3. Si `payment_method === 'cash_register'`: egreso atómico de la caja del
 *      cajero (lock + validar saldo >= amount → si no, 422 'Saldo
 *      insuficiente en la caja.') + INSERT CashRegisterLog(DELIVERY_PAYMENT,
 *      OUT, description `Domicilio: <name>`). El log se enlaza al Delivery.
 *      Si `on_delivery`: NO toca caja.
 *   4. INSERT Delivery.
 *
 * Si CUALQUIER paso falla → rollback total.
 *
 * --------------------------------------------------------------------------
 * Aislamiento transaccional
 * --------------------------------------------------------------------------
 *
 *   Se usa el aislamiento por defecto (`READ COMMITTED`). La correctitud
 *   financiera del egreso de caja NO depende del nivel de aislamiento sino del
 *   lock `pessimistic_write` (`SELECT ... FOR UPDATE`) que adquiere
 *   `getOrCreateCashRegisterForUser` sobre la fila de la caja: dos domicilios
 *   concurrentes contra la misma caja serializan en ese lock y el segundo
 *   re-lee el balance ya descontado por el primero. No hay anomalías de
 *   write-skew porque toda la mutación de saldo gira en torno a una única fila
 *   bloqueada (igual patrón que `expenses`).
 *
 *   NOTA: este lock pessimistic_write es EXCLUSIVO del backend cloud. El
 *   cliente offline (PlacePos / SQLite) NO bloquea la fila de caja — su
 *   concurrencia es single-process, así que no necesita el lock. No hay, por
 *   tanto, "paridad de locking" con el offline; la paridad es de SEMÁNTICA
 *   (mismo egreso, mismo log, mismo mensaje de saldo), no de mecanismo.
 *
 * Multi-tenancy: `company_id` siempre del JWT. Domiciliario, venta y caja se
 * validan/resuelven dentro del tenant.
 */
@Injectable()
export class CreateDeliveryAction {
  private readonly logger = new Logger(CreateDeliveryAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CreateDeliveryDto,
    companyId: number,
    actor: DeliveryActor,
  ): Promise<Delivery> {
    const amountBig: Big = toBig(dto.amount);
    const amount = preciseNumber(amountBig, 2);

    return this.dataSource.transaction<Delivery>(async (manager) => {
      // 1. Domiciliario (dentro del tenant, no archivado). Snapshot del nombre.
      const deliveryCompany = await findDeliveryCompanyInCompany(
        manager,
        dto.delivery_company_id,
        companyId,
        { includeArchived: false },
      );

      // 2. Venta ligada (opcional). Snapshot del ticket.
      //
      // El cliente real envía `invoice_id: null` (no solo `undefined`) cuando
      // el domicilio NO está ligado a una venta. Hay que tratar ambos como
      // "sin venta"; si solo filtramos `undefined`, `null` caería en el lookup
      // con `id: String(null)` y produciría un 'Venta no encontrada' espurio.
      let ticketNumber: string | null = null;
      let invoiceId: string | null = null;
      if (dto.invoice_id !== undefined && dto.invoice_id !== null) {
        const invoice = await manager.findOne(SaleInvoice, {
          where: { id: String(dto.invoice_id), company_id: String(companyId) },
        });
        if (!invoice) {
          throw new NotFoundException('Venta no encontrada');
        }
        invoiceId = String(invoice.id);
        ticketNumber = invoice.ticket_number;
      }

      // 3. Egreso de caja (solo cash_register).
      let cashRegisterLogId: string | null = null;
      if (dto.payment_method === 'cash_register') {
        const { cashRegisterLogId: logId } = await debitCashForDelivery(
          manager,
          companyId,
          amountBig,
          deliveryCompany.name,
          actor,
        );
        cashRegisterLogId = String(logId);
      }

      // 4. INSERT Delivery.
      const delivery = manager.create(Delivery, {
        company_id: String(companyId),
        invoice_id: invoiceId,
        ticket_number: ticketNumber,
        delivery_company_id: String(deliveryCompany.id),
        delivery_company_name: deliveryCompany.name,
        amount,
        payment_method: dto.payment_method,
        notes: dto.notes?.trim() ? dto.notes.trim() : null,
        destination_address: dto.destination_address.trim(),
        recipient_name: dto.recipient_name.trim(),
        cash_register_log_id: cashRegisterLogId,
        is_archived: false,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      });
      const saved = await manager.save(Delivery, delivery);

      this.logger.log({
        event: 'delivery.created',
        companyId,
        deliveryId: Number(saved.id),
        deliveryCompanyId: Number(deliveryCompany.id),
        paymentMethod: dto.payment_method,
        amount,
        cashRegisterLogId: cashRegisterLogId !== null ? Number(cashRegisterLogId) : null,
        actorId: actor.id,
      });

      return saved;
    });
  }
}
