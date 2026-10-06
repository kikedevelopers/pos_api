import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateRestaurantTableDto } from '../dto/create-restaurant-table.dto';
import { RestaurantTable } from '../entities/restaurant-table.entity';
import { translateRestaurantTableConstraintError } from '../internal/constraint-errors';

/** Actor (User/Employee) que crea la mesa; snapshot de auditoría. */
export interface RestaurantTableCreator {
  id: number;
  fullName: string;
}

/**
 * Crea una mesa SUELTA (`POST /restaurant-tables`): sin salón
 * (`salon_id = null`, `owned_by_salon = false`).
 *
 *   - `name` no-blank (400 si vacío), `seats >= 1`.
 *   - 409 si el nombre choca con otra mesa activa de la company.
 */
@Injectable()
export class CreateRestaurantTableAction {
  private readonly logger = new Logger(CreateRestaurantTableAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CreateRestaurantTableDto,
    companyId: number,
    createdBy: RestaurantTableCreator,
  ): Promise<RestaurantTable> {
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('El nombre de la mesa es requerido');
    }

    const saved = await this.dataSource.transaction<RestaurantTable>(async (manager) => {
      const table = manager.create(RestaurantTable, {
        company_id: String(companyId),
        name,
        seats: dto.seats,
        salon_id: null,
        owned_by_salon: false,
        status: 'free',
        is_archived: false,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });

      try {
        return await manager.save(RestaurantTable, table);
      } catch (error) {
        translateRestaurantTableConstraintError(error);
        throw error;
      }
    });

    this.logger.log({
      event: 'restaurant_table.created',
      actorId: createdBy.id,
      companyId,
      tableId: Number(saved.id),
    });

    return saved;
  }
}
