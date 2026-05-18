import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Category } from '../entities/category.entity';
import { findCategoryInCompany } from '../internal/category-lookups';

/**
 * Lookup individual (`GET /categories/:id`). Devuelve 404 si no existe o
 * pertenece a otra company. Incluye archivadas — el frontend puede pedir
 * detalle para historial.
 */
@Injectable()
export class FindCategoryAction {
  constructor(
    @InjectRepository(Category)
    private readonly repo: Repository<Category>,
  ) {}

  execute(id: number, companyId: number): Promise<Category> {
    return findCategoryInCompany(this.repo.manager, id, companyId);
  }
}
