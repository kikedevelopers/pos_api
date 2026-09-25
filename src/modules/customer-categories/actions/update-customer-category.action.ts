import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateCustomerCategoryDto } from '../dto/update-customer-category.dto';
import { CustomerCategory } from '../entities/customer-category.entity';
import { translateCustomerCategoryConstraintError } from '../internal/constraint-errors';
import { findCustomerCategoryInCompany } from '../internal/customer-category-lookups';

/**
 * Actualiza una categoría de cliente (`PUT /customer-categories/:id`).
 *
 *   - 404 si no existe o pertenece a otra company.
 *   - 404 si está archivada (no se renombra archivada).
 *   - 400 si `name` definido pero blank.
 *   - 409 si colisiona con otra categoría activa de la misma company.
 *
 * `created_by` / `created_by_id` son inmutables tras la creación.
 */
@Injectable()
export class UpdateCustomerCategoryAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    id: number,
    dto: UpdateCustomerCategoryDto,
    companyId: number,
  ): Promise<CustomerCategory> {
    return this.dataSource.transaction<CustomerCategory>(async (manager) => {
      const existing = await findCustomerCategoryInCompany(manager, id, companyId);

      if (existing.is_archived) {
        throw new NotFoundException('Categoría de cliente no encontrada');
      }

      const patch: Partial<CustomerCategory> = {};
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
        await manager.update(
          CustomerCategory,
          { id: String(id), company_id: String(companyId) },
          patch,
        );
      } catch (error) {
        translateCustomerCategoryConstraintError(error);
        throw error;
      }

      return findCustomerCategoryInCompany(manager, id, companyId);
    });
  }
}
