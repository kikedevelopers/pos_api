import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { RestaurantTable } from '../entities/restaurant-table.entity';
import { findRestaurantTableInCompany } from '../internal/restaurant-table-lookups';

/**
 * Archiva una mesa (`PUT /restaurant-tables/:id/archive`). Soft-delete: libera
 * el nombre y la saca de los listados. Conserva su `salon_id` como historial;
 * no cuenta en el conteo del salón (los listados filtran `is_archived = false`).
 */
@Injectable()
export class ArchiveRestaurantTableAction {
  private readonly logger = new Logger(ArchiveRestaurantTableAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number): Promise<{ archived: true }> {
    await this.dataSource.transaction(async (manager) => {
      const existing = await findRestaurantTableInCompany(manager, id, companyId);
      if (existing.is_archived) {
        throw new NotFoundException('Mesa no encontrada');
      }
      await manager.update(
        RestaurantTable,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );
    });

    this.logger.log({ event: 'restaurant_table.archived', companyId, tableId: id });
    return { archived: true };
  }
}
