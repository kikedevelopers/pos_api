import { Injectable } from '@nestjs/common';

import { ArchiveCustomerCategoryAction } from './actions/archive-customer-category.action';
import {
  CreateCustomerCategoryAction,
  type CustomerCategoryCreator,
} from './actions/create-customer-category.action';
import { FindAllCustomerCategoriesAction } from './actions/find-all-customer-categories.action';
import { FindCustomerCategoryAction } from './actions/find-customer-category.action';
import { UpdateCustomerCategoryAction } from './actions/update-customer-category.action';
import type { CreateCustomerCategoryDto } from './dto/create-customer-category.dto';
import type { UpdateCustomerCategoryDto } from './dto/update-customer-category.dto';
import type { CustomerCategory } from './entities/customer-category.entity';

/**
 * Facade delgado del dominio `customer-categories` — patrón §3.1 del
 * CLAUDE.md. Solo delega a la action correspondiente; ZERO lógica de negocio.
 */
@Injectable()
export class CustomerCategoriesService {
  constructor(
    private readonly findAllAction: FindAllCustomerCategoriesAction,
    private readonly findOneAction: FindCustomerCategoryAction,
    private readonly createAction: CreateCustomerCategoryAction,
    private readonly updateAction: UpdateCustomerCategoryAction,
    private readonly archiveAction: ArchiveCustomerCategoryAction,
  ) {}

  findAll(companyId: number): Promise<CustomerCategory[]> {
    return this.findAllAction.execute(companyId);
  }

  findOne(id: number, companyId: number): Promise<CustomerCategory> {
    return this.findOneAction.execute(id, companyId);
  }

  create(
    dto: CreateCustomerCategoryDto,
    companyId: number,
    createdBy: CustomerCategoryCreator,
  ): Promise<CustomerCategory> {
    return this.createAction.execute(dto, companyId, createdBy);
  }

  update(id: number, dto: UpdateCustomerCategoryDto, companyId: number): Promise<CustomerCategory> {
    return this.updateAction.execute(id, dto, companyId);
  }

  archive(id: number, companyId: number): Promise<{ archived: true }> {
    return this.archiveAction.execute(id, companyId);
  }
}
