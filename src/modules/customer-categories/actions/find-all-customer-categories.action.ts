import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { CustomerCategory } from '../entities/customer-category.entity';

/**
 * Lista categorías de cliente no archivadas de la company. Endpoint
 * `GET /customer-categories`.
 *
 *   - Filtra `is_archived = false`.
 *   - Ordena por `name ASC`.
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class FindAllCustomerCategoriesAction {
  constructor(
    @InjectRepository(CustomerCategory)
    private readonly repo: Repository<CustomerCategory>,
  ) {}

  execute(companyId: number): Promise<CustomerCategory[]> {
    return this.repo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { name: 'ASC' },
    });
  }
}
