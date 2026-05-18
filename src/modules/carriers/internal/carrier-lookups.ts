import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Carrier } from '../entities/carrier.entity';

/**
 * Lookup por id dentro de una company. Lanza `NotFoundException` si no
 * existe o pertenece a otra company.
 *
 * NO filtra `is_archived`: las mutaciones (update, archive) rechazan
 * archivados explícitamente. Los reads (`find`) sí filtran.
 */
export async function findCarrierInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
): Promise<Carrier> {
  const carrier = await manager.findOne(Carrier, {
    where: { id: String(id), company_id: String(companyId) },
  });
  if (!carrier) {
    throw new NotFoundException('Transportista no encontrado');
  }
  return carrier;
}
