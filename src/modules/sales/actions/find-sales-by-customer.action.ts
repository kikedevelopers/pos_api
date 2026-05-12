import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Customer } from '@/modules/customers/entities/customer.entity';

import { SaleInvoice } from '../entities/sale-invoice.entity';

/**
 * Lista ventas de un cliente dentro de la company.
 *
 * Validación previa: el `customer_id` debe pertenecer a la company. Si
 * no, 404 — defensa anti-enumeración.
 *
 * El feed se restringe a no-anuladas (`is_deleted = false`) ordenadas por
 * `created_at DESC`. Cubre el índice
 * `idx_sale_invoices_company_customer_created`.
 */
@Injectable()
export class FindSalesByCustomerAction {
  constructor(
    @InjectRepository(SaleInvoice)
    private readonly repo: Repository<SaleInvoice>,
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
  ) {}

  async execute(customerId: number, companyId: number): Promise<SaleInvoice[]> {
    const customer = await this.customerRepo.findOne({
      where: { id: String(customerId), company_id: String(companyId) },
    });
    if (!customer) {
      throw new NotFoundException('Cliente no encontrado');
    }

    return this.repo.find({
      where: {
        company_id: String(companyId),
        customer_id: String(customerId),
        is_deleted: false,
      },
      order: { created_at: 'DESC' },
    });
  }
}
