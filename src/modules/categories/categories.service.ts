import { Injectable } from '@nestjs/common';

import type { Product } from '@/modules/products/entities/product.entity';

import { ArchiveCategoryAction } from './actions/archive-category.action';
import { CreateCategoryAction } from './actions/create-category.action';
import { FindAllCategoriesAction } from './actions/find-all-categories.action';
import { FindCategoryAction } from './actions/find-category.action';
import { ListProductsByCategoryAction } from './actions/list-products-by-category.action';
import { UpdateCategoryAction } from './actions/update-category.action';
import type { CreateCategoryDto } from './dto/create-category.dto';
import type { UpdateCategoryDto } from './dto/update-category.dto';
import type { Category } from './entities/category.entity';

/**
 * Facade delgado del dominio `categories` — patrón §3.1 del CLAUDE.md.
 * Solo delega a la action correspondiente; ZERO lógica de negocio.
 */
@Injectable()
export class CategoriesService {
  constructor(
    private readonly findAllCategoriesAction: FindAllCategoriesAction,
    private readonly findCategoryAction: FindCategoryAction,
    private readonly createCategoryAction: CreateCategoryAction,
    private readonly updateCategoryAction: UpdateCategoryAction,
    private readonly archiveCategoryAction: ArchiveCategoryAction,
    private readonly listProductsByCategoryAction: ListProductsByCategoryAction,
  ) {}

  findAll(companyId: number): Promise<Category[]> {
    return this.findAllCategoriesAction.execute(companyId);
  }

  findOne(id: number, companyId: number): Promise<Category> {
    return this.findCategoryAction.execute(id, companyId);
  }

  create(dto: CreateCategoryDto, companyId: number): Promise<Category> {
    return this.createCategoryAction.execute(dto, companyId);
  }

  update(id: number, dto: UpdateCategoryDto, companyId: number): Promise<Category> {
    return this.updateCategoryAction.execute(id, dto, companyId);
  }

  archive(id: number, companyId: number): Promise<{ archived: true }> {
    return this.archiveCategoryAction.execute(id, companyId);
  }

  listProducts(id: number, companyId: number): Promise<Product[]> {
    return this.listProductsByCategoryAction.execute(id, companyId);
  }
}
