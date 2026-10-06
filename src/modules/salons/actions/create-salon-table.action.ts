import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateRestaurantTableDto } from '@/modules/restaurant-tables/dto/create-restaurant-table.dto';
import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';
import { translateRestaurantTableConstraintError } from '@/modules/restaurant-tables/internal/constraint-errors';

import { findSalonInCompany } from '../internal/salon-lookups';

export interface SalonTableCreator {
  id: number;
  fullName: string;
}

/**
 * Crea una mesa DENTRO de un salón (`POST /salons/:id/tables`): queda anclada
 * de forma permanente (`owned_by_salon = true`) y se archivará con el salón.
 *
 *   - 404 si el salón no existe / otra company.
 *   - 400 si el salón está archivado (no se le añaden mesas) o el nombre es
 *     blank.
 *   - 409 si el nombre de mesa choca con otra activa de la company.
 */
@Injectable()
export class CreateSalonTableAction {
  private readonly logger = new Logger(CreateSalonTableAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    salonId: number,
    dto: CreateRestaurantTableDto,
    companyId: number,
    createdBy: SalonTableCreator,
  ): Promise<RestaurantTable> {
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('El nombre de la mesa es requerido');
    }

    const saved = await this.dataSource.transaction<RestaurantTable>(async (manager) => {
      const salon = await findSalonInCompany(manager, salonId, companyId);
      if (salon.is_archived) {
        throw new BadRequestException('No se pueden añadir mesas a un salón archivado');
      }

      const table = manager.create(RestaurantTable, {
        company_id: String(companyId),
        name,
        seats: dto.seats,
        salon_id: String(salonId),
        owned_by_salon: true,
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
      event: 'salon_table.created',
      actorId: createdBy.id,
      companyId,
      salonId,
      tableId: Number(saved.id),
    });
    return saved;
  }
}
