import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateCategoryDto } from '../dto/update-category.dto';
import { Category } from '../entities/category.entity';
import { findCategoryInCompany } from '../internal/category-lookups';
import { translateCategoryConstraintError } from '../internal/constraint-errors';

/**
 * Actualiza una categoría (`PUT /categories/:id`).
 *
 *   - 404 si no existe o pertenece a otra company.
 *   - 404 si está archivada (espejo PlacePos — no se renombra archivada).
 *   - 400 si `name` definido pero blank.
 *   - 409 si colisiona con otra categoría activa de la misma company.
 */
@Injectable()
export class UpdateCategoryAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, dto: UpdateCategoryDto, companyId: number): Promise<Category> {
    return this.dataSource.transaction<Category>(async (manager) => {
      const existing = await findCategoryInCompany(manager, id, companyId);

      if (existing.is_archived) {
        throw new NotFoundException('Categoría no encontrada');
      }

      const patch: Partial<Category> = {};
      if (dto.name !== undefined) {
        const trimmed = dto.name.trim();
        if (!trimmed) {
          throw new BadRequestException('El nombre de la categoría es requerido');
        }
        patch.name = trimmed;
      }

      if (Object.keys(patch).length === 0) {
        return existing;
      }

      try {
        await manager.update(Category, { id: String(id), company_id: String(companyId) }, patch);
      } catch (error) {
        translateCategoryConstraintError(error);
        throw error;
      }

      return findCategoryInCompany(manager, id, companyId);
    });
  }
}
