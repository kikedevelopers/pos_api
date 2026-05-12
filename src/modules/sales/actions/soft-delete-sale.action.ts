import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';
import { SalePayment } from '../entities/sale-payment.entity';
import { findSaleInCompany } from '../internal/sale-lookups';

/**
 * Anula (soft-delete) una venta. SOLO permitido para `ORDER` sin pagos.
 *
 * Para anular una `SALE` confirmada se usa la `CreditNote(FULL_VOID)` que
 * vive en Fase 8 — espejo PlacePos.
 *
 * --------------------------------------------------------------------------
 * Pasos (UNA transacción)
 * --------------------------------------------------------------------------
 *
 *   1. Lock pessimistic_write sobre la venta.
 *   2. Validar ticket_type = ORDER. Si SALE → 422 con código
 *      `SALE_REQUIRES_CREDIT_NOTE`.
 *   3. Validar que no haya pagos. Si los hay → 422.
 *   4. UPDATE `is_deleted = true`.
 *
 * No tocamos `Customer.balance` porque las ORDER no generan SaleCredit
 * (solo SALE puede; ver `create-sale.action`).
 */
@Injectable()
export class SoftDeleteSaleAction {
  private readonly logger = new Logger(SoftDeleteSaleAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, actorId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const sale = await findSaleInCompany(manager, id, companyId, {
        requireActive: true,
        lock: true,
      });

      if (sale.ticket_type !== TicketType.ORDER) {
        throw new UnprocessableEntityException({
          message: 'Venta confirmada. Usa una nota de crédito para anularla.',
          payload: { code: 'SALE_REQUIRES_CREDIT_NOTE' },
        });
      }

      const paymentsCount = await manager.count(SalePayment, {
        where: { sale_invoice_id: sale.id, company_id: String(companyId) },
      });
      if (paymentsCount > 0) {
        throw new UnprocessableEntityException({
          message: 'No se puede anular una venta con pagos aplicados',
          payload: { code: 'SALE_HAS_PAYMENTS' },
        });
      }

      await manager.update(
        SaleInvoice,
        { id: sale.id, company_id: String(companyId) },
        { is_deleted: true },
      );

      this.logger.log({
        event: 'sale.soft_deleted',
        companyId,
        saleId: Number(sale.id),
        actorId,
      });
    });
  }
}
