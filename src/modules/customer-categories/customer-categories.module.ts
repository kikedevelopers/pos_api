import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ArchiveCustomerCategoryAction } from './actions/archive-customer-category.action';
import { CreateCustomerCategoryAction } from './actions/create-customer-category.action';
import { FindAllCustomerCategoriesAction } from './actions/find-all-customer-categories.action';
import { FindCustomerCategoryAction } from './actions/find-customer-category.action';
import { UpdateCustomerCategoryAction } from './actions/update-customer-category.action';
import { CustomerCategoriesController } from './customer-categories.controller';
import { CustomerCategoriesService } from './customer-categories.service';
import { CustomerCategory } from './entities/customer-category.entity';

/**
 * Módulo `customer-categories` — categorías especiales de clientes.
 *
 * Espejo estructural del `CategoriesModule` (categorías de producto). Exporta
 * el service y `TypeOrmModule` por si módulos futuros necesitan leerlas.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CustomerCategory])],
  controllers: [CustomerCategoriesController],
  providers: [
    CustomerCategoriesService,
    FindAllCustomerCategoriesAction,
    FindCustomerCategoryAction,
    CreateCustomerCategoryAction,
    UpdateCustomerCategoryAction,
    ArchiveCustomerCategoryAction,
  ],
  exports: [CustomerCategoriesService, TypeOrmModule],
})
export class CustomerCategoriesModule {}
