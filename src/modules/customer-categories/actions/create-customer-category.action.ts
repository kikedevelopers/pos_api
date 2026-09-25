import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateCustomerCategoryDto } from '../dto/create-customer-category.dto';
import { CustomerCategory } from '../entities/customer-category.entity';
import { translateCustomerCategoryConstraintError } from '../internal/constraint-errors';

/**
 * Datos del actor (User u Employee) que el controller propaga al action.
 * Espejo del `CustomerCreator` del módulo customers. Se congela como snapshot
 * de auditoría en `created_by` / `created_by_id`.
 */
export interface CustomerCategoryCreator {
  id: number;
  fullName: string;
}

/**
 * Crea una categoría de cliente (`POST /customer-categories`).
 *
 * Reglas:
 *   - `name` obligatorio, no-blank. 400 si vacío.
 *   - UNIQUE per-company sobre `lower(btrim(name))` para activas: 409 si
 *     colisión (traducido por `translateCustomerCategoryConstraintError`).
 *   - `created_by` / `created_by_id` se congelan desde el actor autenticado,
 *     NUNCA del DTO.
 *
 * Transacción CLAUDE.md §8.8 — defensa en profundidad para futuros side-effects.
 */
@Injectable()
export class CreateCustomerCategoryAction {
  private readonly logger = new Logger(CreateCustomerCategoryAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CreateCustomerCategoryDto,
    companyId: number,
    createdBy: CustomerCategoryCreator,
  ): Promise<CustomerCategory> {
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('El nombre de la categoría es requerido');
    }

    const saved = await this.dataSource.transaction<CustomerCategory>(async (manager) => {
      const category = manager.create(CustomerCategory, {
        company_id: String(companyId),
        name,
        is_archived: false,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });

      try {
        return await manager.save(CustomerCategory, category);
      } catch (error) {
        translateCustomerCategoryConstraintError(error);
        throw error;
      }
    });

    this.logger.log({
      event: 'customer_category.created',
      actorId: createdBy.id,
      companyId,
      customerCategoryId: Number(saved.id),
    });

    return saved;
  }
}
