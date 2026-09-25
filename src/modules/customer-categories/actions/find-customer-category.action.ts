import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { CustomerCategory } from '../entities/customer-category.entity';
import { findCustomerCategoryInCompany } from '../internal/customer-category-lookups';

/**
 * Lookup individual (`GET /customer-categories/:id`). Devuelve 404 si no
 * existe o pertenece a otra company. Incluye archivadas — el frontend puede
 * pedir detalle para historial.
 */
@Injectable()
export class FindCustomerCategoryAction {
  constructor(
    @InjectRepository(CustomerCategory)
    private readonly repo: Repository<CustomerCategory>,
  ) {}

  execute(id: number, companyId: number): Promise<CustomerCategory> {
    return findCustomerCategoryInCompany(this.repo.manager, id, companyId);
  }
}
