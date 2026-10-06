import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';
import { findRestaurantTableInCompany } from '@/modules/restaurant-tables/internal/restaurant-table-lookups';

import { findSalonInCompany } from '../internal/salon-lookups';

/**
 * Ancla una mesa EXISTENTE suelta a un salón
 * (`POST /salons/:salonId/tables/:tableId/attach`). Queda `owned_by_salon =
 * false`: al archivar el salón se desanclará (no se archiva).
 *
 *   - 404 si el salón o la mesa no existen / otra company.
 *   - 400 si el salón está archivado, la mesa está archivada, o la mesa ya está
 *     anclada a ESTE mismo salón.
 *   - 409 si la mesa ya está anclada a OTRO salón (hay que desanclarla primero).
 */
@Injectable()
export class AttachTableAction {
  private readonly logger = new Logger(AttachTableAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(salonId: number, tableId: number, companyId: number): Promise<RestaurantTable> {
    return this.dataSource.transaction<RestaurantTable>(async (manager) => {
      const salon = await findSalonInCompany(manager, salonId, companyId);
      if (salon.is_archived) {
        throw new BadRequestException('No se pueden anclar mesas a un salón archivado');
      }

      const table = await findRestaurantTableInCompany(manager, tableId, companyId);
      if (table.is_archived) {
        throw new BadRequestException('No se puede anclar una mesa archivada');
      }
      if (table.salon_id === String(salonId)) {
        throw new BadRequestException('La mesa ya está anclada a este salón');
      }
      if (table.salon_id !== null) {
        throw new ConflictException({
          message: 'La mesa ya está anclada a otro salón. Desánclala primero.',
          payload: { code: 'TABLE_ALREADY_IN_SALON' },
        });
      }

      await manager.update(
        RestaurantTable,
        { id: String(tableId), company_id: String(companyId) },
        { salon_id: String(salonId), owned_by_salon: false },
      );

      this.logger.log({ event: 'salon_table.attached', companyId, salonId, tableId });
      return findRestaurantTableInCompany(manager, tableId, companyId);
    });
  }
}
