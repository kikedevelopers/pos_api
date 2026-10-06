import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';
import { findRestaurantTableInCompany } from '@/modules/restaurant-tables/internal/restaurant-table-lookups';

import { findSalonInCompany } from '../internal/salon-lookups';

/**
 * Desancla una mesa de un salón
 * (`POST /salons/:salonId/tables/:tableId/detach`): queda suelta
 * (`salon_id = null`).
 *
 *   - 404 si el salón o la mesa no existen / otra company.
 *   - 400 si la mesa no está anclada a ESTE salón.
 *   - 400 si la mesa fue CREADA dentro del salón (`owned_by_salon = true`): el
 *     anclaje es permanente; para quitarla hay que archivarla.
 */
@Injectable()
export class DetachTableAction {
  private readonly logger = new Logger(DetachTableAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(salonId: number, tableId: number, companyId: number): Promise<RestaurantTable> {
    return this.dataSource.transaction<RestaurantTable>(async (manager) => {
      await findSalonInCompany(manager, salonId, companyId);
      const table = await findRestaurantTableInCompany(manager, tableId, companyId);

      if (table.salon_id !== String(salonId)) {
        throw new BadRequestException('La mesa no está anclada a este salón');
      }
      if (table.owned_by_salon) {
        throw new BadRequestException(
          'Esta mesa se creó dentro del salón y no se puede desanclar; archívala.',
        );
      }

      await manager.update(
        RestaurantTable,
        { id: String(tableId), company_id: String(companyId) },
        { salon_id: null },
      );

      this.logger.log({ event: 'salon_table.detached', companyId, salonId, tableId });
      return findRestaurantTableInCompany(manager, tableId, companyId);
    });
  }
}
