import { NotFoundException } from '@nestjs/common';
import { type EntityManager } from 'typeorm';

import { RestaurantTable } from '../entities/restaurant-table.entity';

/**
 * Lookup de mesa por id dentro de una company. Lanza 404 si no existe o es de
 * otra company (anti-enumeración). NO filtra `is_archived`.
 */
export async function findRestaurantTableInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
): Promise<RestaurantTable> {
  const table = await manager.findOne(RestaurantTable, {
    where: { id: String(id), company_id: String(companyId) },
  });
  if (!table) {
    throw new NotFoundException('Mesa no encontrada');
  }
  return table;
}
