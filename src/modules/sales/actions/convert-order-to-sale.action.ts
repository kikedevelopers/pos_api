import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';

import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';
import { translateSaleConstraintError } from '../internal/constraint-errors';
import {
  findSaleCredit,
  findSaleInCompany,
  findSaleLines,
  findSalePayments,
} from '../internal/sale-lookups';
import type { SaleAggregate } from './find-sale.action';

/**
 * Convierte una venta `ORDER` en `SALE`. Espejo del flujo PlacePos donde,
 * al confirmar un pedido, el sistema genera un folio del tipo SALE y lo
 * fija en `sale_number` sin alterar el `ticket_number` original (este
 * último permanece como referencia del pedido).
 *
 * --------------------------------------------------------------------------
 * Pasos (UNA transacción)
 * --------------------------------------------------------------------------
 *
 *   1. Lock pessimistic_write sobre la venta.
 *   2. Validar que sea ORDER. Si ya es SALE → 422.
 *   3. Generar `sale_number` con `IncrementTicketNumberAction` para
 *      `ticket_type = SALE`.
 *   4. UPDATE `sale_invoices SET ticket_type = SALE, sale_number = $folio`.
 *
 * Idempotencia: si la venta ya es SALE (ej. doble click del frontend), el
 * 422 protege contra doble conversión. El cliente puede capturar el código
 * para mostrar un mensaje al usuario.
 */
@Injectable()
export class ConvertOrderToSaleAction {
  private readonly logger = new Logger(ConvertOrderToSaleAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly incrementTicketNumberAction: IncrementTicketNumberAction,
  ) {}

  async execute(id: number, companyId: number, actorId: number): Promise<SaleAggregate> {
    return this.dataSource.transaction<SaleAggregate>(async (manager) => {
      const sale = await findSaleInCompany(manager, id, companyId, {
        requireActive: true,
        lock: true,
      });

      if (sale.ticket_type === TicketType.SALE) {
        throw new UnprocessableEntityException({
          message: 'La venta ya está confirmada como SALE',
          payload: { code: 'SALE_ALREADY_CONFIRMED' },
        });
      }

      // Genera nuevo folio de SALE (atómico, separado del contador de ORDER).
      const saleTicket = await this.incrementTicketNumberAction.execute(
        manager,
        companyId,
        TicketSettingType.SALE,
      );

      try {
        await manager.update(
          SaleInvoice,
          { id: sale.id, company_id: String(companyId) },
          {
            ticket_type: TicketType.SALE,
            sale_number: saleTicket.formatted,
          },
        );
      } catch (error) {
        translateSaleConstraintError(error);
        throw error;
      }

      this.logger.log({
        event: 'sale.converted_to_sale',
        companyId,
        saleId: Number(sale.id),
        prevTicketNumber: sale.ticket_number,
        saleNumber: saleTicket.formatted,
        actorId,
      });

      return this.loadAggregate(manager, Number(sale.id), companyId);
    });
  }

  private async loadAggregate(
    manager: EntityManager,
    saleId: number,
    companyId: number,
  ): Promise<SaleAggregate> {
    const reloaded = await manager.findOne(SaleInvoice, {
      where: { id: String(saleId), company_id: String(companyId) },
    });
    if (!reloaded) {
      throw new UnprocessableEntityException('Venta no encontrada tras conversión');
    }
    const lines = await findSaleLines(manager, saleId, companyId);
    const payments = await findSalePayments(manager, saleId, companyId);
    const credit = await findSaleCredit(manager, saleId, companyId);
    return { sale: reloaded, lines, payments, credit };
  }
}
