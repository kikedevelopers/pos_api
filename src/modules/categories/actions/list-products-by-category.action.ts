import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Product } from '@/modules/products/entities/product.entity';

import { Category } from '../entities/category.entity';
import { findCategoryInCompany } from '../internal/category-lookups';

/**
 * Lista los productos no archivados que pertenecen a una categoría
 * (`GET /categories/:id/products`).
 *
 * Reglas:
 *   - 404 si la categoría no existe o pertenece a otra company.
 *   - Devuelve productos `is_archived = false` con `parent` y `packaging`
 *     cargados (espejo PlacePos).
 *   - Multi-tenant doble filtro (defense in depth): `product.company_id`
 *     debe coincidir además de `category_id`.
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class ListProductsByCategoryAction {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
  ) {}

  async execute(categoryId: number, companyId: number): Promise<Product[]> {
    await findCategoryInCompany(this.categoryRepo.manager, categoryId, companyId);

    return this.productRepo
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.parent', 'parent')
      .leftJoinAndSelect('p.packaging', 'packaging')
      .where('p.company_id = :companyId', { companyId: String(companyId) })
      .andWhere('p.category_id = :categoryId', { categoryId: String(categoryId) })
      .andWhere('p.is_archived = false')
      .orderBy('p.name', 'ASC')
      .getMany();
  }
}
