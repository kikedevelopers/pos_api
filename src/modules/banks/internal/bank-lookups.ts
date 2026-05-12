import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';

/**
 * Helper interno del módulo banks. Lookup por id dentro de una company
 * usando un `EntityManager` (transaccional o no). Lanza
 * `NotFoundException` si no existe O pertenece a otra company — no se
 * distinguen los dos casos (anti-enumeración cross-tenant).
 *
 * Por defecto NO filtra `is_archived`: las actions de update/archive
 * necesitan ver el row activo, pero el listado público sí filtra.
 *
 * `requireActive = true` añade el filtro `is_archived = false` para las
 * actions que solo operan sobre bancos activos (update, archive).
 */
export async function findBankInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
  options: { requireActive?: boolean } = {},
): Promise<Bank> {
  const where: { id: string; company_id: string; is_archived?: boolean } = {
    id: String(id),
    company_id: String(companyId),
  };
  if (options.requireActive === true) {
    where.is_archived = false;
  }

  const bank = await manager.findOne(Bank, { where });
  if (!bank) {
    throw new NotFoundException('Cuenta bancaria no encontrada');
  }
  return bank;
}
