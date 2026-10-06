import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';

import { Salon } from '../entities/salon.entity';

/** Salón + su número de mesas activas (no es columna; lo calcula el action). */
export interface SalonWithTableCount {
  salon: Salon;
  tableCount: number;
}

/**
 * Lista los salones no archivados de la company con el conteo de mesas activas
 * ancladas a cada uno (`GET /salons`). Read puro.
 *
 * Dos queries (sin N+1): los salones y un `GROUP BY salon_id` de mesas activas.
 * Se combinan en memoria.
 */
@Injectable()
export class FindAllSalonsAction {
  constructor(
    @InjectRepository(Salon)
    private readonly salonRepo: Repository<Salon>,
    @InjectRepository(RestaurantTable)
    private readonly tableRepo: Repository<RestaurantTable>,
  ) {}

  async execute(companyId: number): Promise<SalonWithTableCount[]> {
    const salons = await this.salonRepo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { name: 'ASC' },
    });

    const rawCounts = await this.tableRepo
      .createQueryBuilder('t')
      .select('t.salon_id', 'salon_id')
      .addSelect('COUNT(*)', 'count')
      .where('t.company_id = :companyId', { companyId: String(companyId) })
      .andWhere('t.is_archived = false')
      .andWhere('t.salon_id IS NOT NULL')
      .groupBy('t.salon_id')
      .getRawMany<{ salon_id: string; count: string }>();

    const countBySalon = new Map<string, number>(
      rawCounts.map((row) => [String(row.salon_id), Number(row.count)]),
    );

    return salons.map((salon) => ({
      salon,
      tableCount: countBySalon.get(salon.id) ?? 0,
    }));
  }
}
