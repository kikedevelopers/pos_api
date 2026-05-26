import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';

import type { DeliveryPrefillResponseDto } from '../dto/delivery-response.dto';

/**
 * Prefill para `GET /deliveries/prefill/:invoiceId`. Carga la venta del tenant
 * con su relación `customer` y devuelve los datos para pre-llenar el
 * formulario de domicilio.
 *
 * Reglas de resolución (contrato Domiciliarios):
 *   - `customer_name`    = customer?.name ?? sale.customer_name (snapshot)
 *   - `customer_address` = customer?.address ?? null
 *   - `ticket_number`    = sale.ticket_number
 *   - `has_customer`     = la venta tiene customer ligado (customer_id != null)
 *
 * Multi-tenancy: la venta SIEMPRE se busca filtrando por `company_id` del JWT;
 * 404 si no existe o pertenece a otro tenant.
 */
@Injectable()
export class PrefillDeliveryAction {
  constructor(
    @InjectRepository(SaleInvoice)
    private readonly salesRepo: Repository<SaleInvoice>,
  ) {}

  async execute(invoiceId: number, companyId: number): Promise<DeliveryPrefillResponseDto> {
    const invoice = await this.salesRepo.findOne({
      where: { id: String(invoiceId), company_id: String(companyId) },
      relations: { customer: true },
    });
    if (!invoice) {
      throw new NotFoundException('Venta no encontrada');
    }

    const customer = invoice.customer;
    const customerName = customer?.name ?? invoice.customer_name ?? null;
    const customerAddress = customer?.address ?? null;
    const hasCustomer = invoice.customer_id !== null && invoice.customer_id !== undefined;

    return {
      invoice_id: Number(invoice.id),
      ticket_number: invoice.ticket_number,
      customer_name: customerName,
      customer_address: customerAddress,
      has_customer: hasCustomer,
    };
  }
}
