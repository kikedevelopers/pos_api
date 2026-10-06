import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateRestaurantTableDto } from '../dto/update-restaurant-table.dto';
import { RestaurantTable } from '../entities/restaurant-table.entity';
import { translateRestaurantTableConstraintError } from '../internal/constraint-errors';
import { findRestaurantTableInCompany } from '../internal/restaurant-table-lookups';

/**
 * Edita el nombre y/o nº de sillas de una mesa (`PUT /restaurant-tables/:id`).
 *
 *   - 404 si no existe / otra company / archivada.
 *   - 400 si `name` definido pero blank, o `seats` definido y < 1.
 *   - 409 si el nombre choca con otra mesa activa.
 *
 * El anclaje (`salon_id` / `owned_by_salon`) NO se edita aquí; se gestiona con
 * los endpoints de anclaje del salón.
 */
@Injectable()
export class UpdateRestaurantTableAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    id: number,
    dto: UpdateRestaurantTableDto,
    companyId: number,
  ): Promise<RestaurantTable> {
    return this.dataSource.transaction<RestaurantTable>(async (manager) => {
      const existing = await findRestaurantTableInCompany(manager, id, companyId);
      if (existing.is_archived) {
        throw new NotFoundException('Mesa no encontrada');
      }

      const patch: Partial<RestaurantTable> = {};
      if (dto.name !== undefined) {
        const trimmed = dto.name.trim();
        if (!trimmed) {
          throw new BadRequestException('El nombre de la mesa es requerido');
        }
        patch.name = trimmed;
      }
      if (dto.seats !== undefined) {
        if (!Number.isInteger(dto.seats) || dto.seats < 1) {
          throw new BadRequestException('La mesa debe tener al menos 1 silla');
        }
        patch.seats = dto.seats;
      }

      if (Object.keys(patch).length === 0) {
        return existing;
      }

      try {
        await manager.update(
          RestaurantTable,
          { id: String(id), company_id: String(companyId) },
          patch,
        );
      } catch (error) {
        translateRestaurantTableConstraintError(error);
        throw error;
      }

      return findRestaurantTableInCompany(manager, id, companyId);
    });
  }
}
