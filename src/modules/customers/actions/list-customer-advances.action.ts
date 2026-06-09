import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type Repository } from 'typeorm';

import { CustomerAdvance } from '../entities/customer-advance.entity';
import { findCustomerInCompany } from '../internal/customer-lookups';

/**
 * Lista los anticipos de un customer (`GET /customers/:id/advances`), ordenados
 * por `created_at DESC`.
 *
 * Read puro. Verifica primero que el customer pertenezca a la company (404 si
 * no) — anti-enumeración cross-tenant. El listado filtra además por
 * `company_id` (defensa en profundidad) y aprovecha el índice
 * `idx_customer_advances_company_customer_created`.
 */
@Injectable()
export class ListCustomerAdvancesAction {
  constructor(
    @InjectRepository(CustomerAdvance)
    private readonly repo: Repository<CustomerAdvance>,
  ) {}

  async execute(customerId: number, companyId: number): Promise<CustomerAdvance[]> {
    // 404 si el customer no existe / es de otra company.
    await findCustomerInCompany(this.repo.manager, customerId, companyId);

    return this.repo.find({
      where: {
        company_id: String(companyId),
        customer_id: String(customerId),
      },
      order: { created_at: 'DESC' },
    });
  }
}
