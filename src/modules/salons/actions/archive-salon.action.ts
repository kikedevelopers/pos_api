import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';

import { Salon } from '../entities/salon.entity';
import { findSalonInCompany } from '../internal/salon-lookups';

/**
 * Archiva un salón (`PUT /salons/:id/archive`) y reconcilia sus mesas, todo en
 * una transacción:
 *
 *   - Mesas CREADAS dentro del salón (`owned_by_salon = true`): se ARCHIVAN con
 *     él (anclaje permanente).
 *   - Mesas EXISTENTES ancladas (`owned_by_salon = false`): se DESANCLAN
 *     (`salon_id = null`) y quedan sueltas de nuevo (no se archivan).
 *   - El salón queda `is_archived = true`.
 *
 * 404 si no existe, es de otra company o ya está archivado.
 */
@Injectable()
export class ArchiveSalonAction {
  private readonly logger = new Logger(ArchiveSalonAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number): Promise<{ archived: true }> {
    await this.dataSource.transaction(async (manager) => {
      const existing = await findSalonInCompany(manager, id, companyId);
      if (existing.is_archived) {
        throw new NotFoundException('Salón no encontrado');
      }

      // Mesas propias (creadas en el salón) → se archivan con él.
      await manager.update(
        RestaurantTable,
        {
          company_id: String(companyId),
          salon_id: String(id),
          owned_by_salon: true,
          is_archived: false,
        },
        { is_archived: true },
      );

      // Mesas ancladas activas (existían antes) → se desanclan, quedan sueltas.
      // Las ya archivadas conservan su salon_id como historial.
      await manager.update(
        RestaurantTable,
        {
          company_id: String(companyId),
          salon_id: String(id),
          owned_by_salon: false,
          is_archived: false,
        },
        { salon_id: null },
      );

      await manager.update(
        Salon,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );
    });

    this.logger.log({ event: 'salon.archived', companyId, salonId: id });
    return { archived: true };
  }
}
