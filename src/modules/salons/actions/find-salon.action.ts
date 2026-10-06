import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';

import { Salon } from '../entities/salon.entity';
import { findSalonInCompany } from '../internal/salon-lookups';

export interface SalonWithTables {
  salon: Salon;
  tables: RestaurantTable[];
}

/**
 * Detalle de un salón + sus mesas activas (`GET /salons/:id`). 404 cross-tenant.
 * Las mesas archivadas no se incluyen.
 */
@Injectable()
export class FindSalonAction {
  constructor(
    @InjectRepository(Salon)
    private readonly salonRepo: Repository<Salon>,
    @InjectRepository(RestaurantTable)
    private readonly tableRepo: Repository<RestaurantTable>,
  ) {}

  async execute(id: number, companyId: number): Promise<SalonWithTables> {
    const salon = await findSalonInCompany(this.salonRepo.manager, id, companyId);
    if (salon.is_archived) {
      throw new NotFoundException('Salón no encontrado');
    }
    const tables = await this.tableRepo.find({
      where: { company_id: String(companyId), salon_id: String(id), is_archived: false },
      order: { name: 'ASC' },
    });
    return { salon, tables };
  }
}
