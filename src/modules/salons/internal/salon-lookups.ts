import { NotFoundException } from '@nestjs/common';
import { type EntityManager } from 'typeorm';

import { Salon } from '../entities/salon.entity';

/**
 * Lookup de salón por id dentro de una company. Lanza 404 si no existe o es de
 * otra company (anti-enumeración cross-tenant). NO filtra `is_archived`.
 */
export async function findSalonInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
): Promise<Salon> {
  const salon = await manager.findOne(Salon, {
    where: { id: String(id), company_id: String(companyId) },
  });
  if (!salon) {
    throw new NotFoundException('Salón no encontrado');
  }
  return salon;
}
