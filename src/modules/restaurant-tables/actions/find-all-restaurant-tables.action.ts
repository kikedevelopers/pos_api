import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, type Repository } from 'typeorm';

import { RestaurantTable } from '../entities/restaurant-table.entity';

/** Alcance del listado de mesas. */
export type RestaurantTableScope = 'all' | 'loose';

/**
 * Lista las mesas activas de la company. `GET /restaurant-tables`.
 *
 *   - `scope = 'all'` (default): todas las mesas activas.
 *   - `scope = 'loose'`: solo las SUELTAS (sin salón) — las candidatas a anclar
 *     a un salón.
 *
 * Read puro — sin transacción. Orden por nombre.
 */
@Injectable()
export class FindAllRestaurantTablesAction {
  constructor(
    @InjectRepository(RestaurantTable)
    private readonly repo: Repository<RestaurantTable>,
  ) {}

  execute(companyId: number, scope: RestaurantTableScope = 'all'): Promise<RestaurantTable[]> {
    return this.repo.find({
      where: {
        company_id: String(companyId),
        is_archived: false,
        ...(scope === 'loose' ? { salon_id: IsNull() } : {}),
      },
      order: { name: 'ASC' },
    });
  }
}
