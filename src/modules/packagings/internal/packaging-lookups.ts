import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Packaging } from '@/modules/packagings/entities/packaging.entity';

/**
 * Lookup por id dentro de una company. Lanza `NotFoundException` si no
 * existe O pertenece a otra company. No se distingue entre los dos casos —
 * anti-enumeración cross-tenant.
 *
 * Por defecto filtra `is_archived = false` (paridad con PlacePos: las
 * mutaciones `PUT /packagings/:id` y `PUT /packagings/:id/archive` solo
 * operan sobre empaques activos). El flag `includeArchived` se reserva
 * para reportes futuros.
 *
 * Recibe un `EntityManager` para que las actions de mutación puedan
 * reutilizar la lectura DENTRO de la misma transacción (snapshot isolation).
 */
export async function findPackagingInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
  options: { includeArchived?: boolean } = {},
): Promise<Packaging> {
  const where: Record<string, unknown> = {
    id: String(id),
    company_id: String(companyId),
  };
  if (options.includeArchived !== true) {
    where.is_archived = false;
  }

  const packaging = await manager.findOne(Packaging, { where });
  if (!packaging) {
    throw new NotFoundException('Empaque no encontrado.');
  }
  return packaging;
}
