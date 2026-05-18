import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import { ArchiveCategoryAction } from './actions/archive-category.action';
import { CreateCategoryAction } from './actions/create-category.action';
import { FindAllCategoriesAction } from './actions/find-all-categories.action';
import { FindCategoryAction } from './actions/find-category.action';
import { ListProductsByCategoryAction } from './actions/list-products-by-category.action';
import { UpdateCategoryAction } from './actions/update-category.action';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { Category } from './entities/category.entity';

/**
 * Módulo `categories` — Fase 2A.
 *
 * Registra `Product` en TypeOrmModule.forFeature para que
 * `ListProductsByCategoryAction` pueda inyectar su repositorio sin
 * depender del ProductsModule completo (evita ciclos).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Category, Product])],
  controllers: [CategoriesController],
  providers: [
    CategoriesService,
    FindAllCategoriesAction,
    FindCategoryAction,
    CreateCategoryAction,
    UpdateCategoryAction,
    ArchiveCategoryAction,
    ListProductsByCategoryAction,
  ],
  exports: [CategoriesService, TypeOrmModule],
})
export class CategoriesModule {}
