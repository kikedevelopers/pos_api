import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateCategoryDto } from '../dto/create-category.dto';
import { Category } from '../entities/category.entity';
import { translateCategoryConstraintError } from '../internal/constraint-errors';

/**
 * Crea una categoría (`POST /categories`).
 *
 * Reglas:
 *   - `name` obligatorio, no-blank. 400 si vacío.
 *   - UNIQUE per-company sobre `lower(btrim(name))` para activas: 409 si
 *     colisión (traducido por `translateCategoryConstraintError`).
 *
 * Transacción CLAUDE.md §8.8 — defensa en profundidad para futuros side-effects.
 */
@Injectable()
export class CreateCategoryAction {
  private readonly logger = new Logger(CreateCategoryAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(dto: CreateCategoryDto, companyId: number): Promise<Category> {
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('El nombre de la categoría es requerido');
    }

    const saved = await this.dataSource.transaction<Category>(async (manager) => {
      const category = manager.create(Category, {
        company_id: String(companyId),
        name,
        is_archived: false,
      });

      try {
        return await manager.save(Category, category);
      } catch (error) {
        translateCategoryConstraintError(error);
        throw error;
      }
    });

    this.logger.log({
      event: 'category.created',
      companyId,
      categoryId: Number(saved.id),
    });

    return saved;
  }
}
