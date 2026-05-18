import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Category } from '../entities/category.entity';

/**
 * Lista categorías no archivadas de la company. Endpoint `GET /categories`.
 *
 * Paridad PlacePos:
 *   - Filtra `is_archived = false`.
 *   - Ordena por `name ASC`.
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class FindAllCategoriesAction {
  constructor(
    @InjectRepository(Category)
    private readonly repo: Repository<Category>,
  ) {}

  execute(companyId: number): Promise<Category[]> {
    return this.repo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { name: 'ASC' },
    });
  }
}
