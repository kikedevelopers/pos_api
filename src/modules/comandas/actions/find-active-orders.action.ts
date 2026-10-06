import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '@/modules/sales/entities/sale-invoice.entity';

import { ComandaDto, toComandaDto } from '../dto/comanda.dto';

/**
 * Lista las COMANDAS de una company: los pedidos `ORDER` ACTIVOS, es decir los
 * que aún no se han cobrado ni anulado.
 *
 * - Cobrar un pedido lo convierte en `SALE` (ver ProcessPaymentAction) → sale
 *   de la lista solo.
 * - Anular un pedido lo marca `is_deleted = true` (ver VoidSaleAction) → sale
 *   de la lista solo.
 *
 * Orden FIFO (`created_at` ASC): el más viejo primero, el más nuevo al final —
 * la cola natural de cocina. Trae las líneas en UN batch (sin N+1) y las agrupa
 * por pedido, respetando el id ASC para que el orden de los productos sea el de
 * captura.
 */
@Injectable()
export class FindActiveOrdersAction {
  constructor(
    @InjectRepository(SaleInvoice)
    private readonly salesRepo: Repository<SaleInvoice>,
    @InjectRepository(SaleInvoiceLine)
    private readonly linesRepo: Repository<SaleInvoiceLine>,
  ) {}

  async execute(companyId: number): Promise<ComandaDto[]> {
    const orders = await this.salesRepo.find({
      where: {
        company_id: String(companyId),
        ticket_type: TicketType.ORDER,
        is_deleted: false,
      },
      order: { created_at: 'ASC', id: 'ASC' },
    });

    if (orders.length === 0) {
      return [];
    }

    const orderIds = orders.map((o) => o.id);
    const lines = await this.linesRepo.find({
      where: { sale_invoice_id: In(orderIds), company_id: String(companyId) },
      order: { id: 'ASC' },
    });

    const linesByOrder = new Map<string, SaleInvoiceLine[]>();
    for (const line of lines) {
      const bucket = linesByOrder.get(line.sale_invoice_id);
      if (bucket) {
        bucket.push(line);
      } else {
        linesByOrder.set(line.sale_invoice_id, [line]);
      }
    }

    return orders.map((order) => toComandaDto(order, linesByOrder.get(order.id) ?? []));
  }
}
