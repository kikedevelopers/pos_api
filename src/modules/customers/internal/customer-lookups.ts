import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Customer } from '@/modules/customers/entities/customer.entity';

/**
 * Lookup por id dentro de una company usando un `EntityManager` (transaccional
 * o no). Lanza `NotFoundException` si no existe O pertenece a otra company.
 * No se distingue entre los dos casos — anti-enumeración cross-tenant.
 *
 * NO filtra `is_archived`: las actions de update y archive operan sobre
 * activos y archivados. El listado público sí filtra por `is_archived = false`
 * salvo que el caller pida `include_archived`.
 *
 * Se expone como helper interno (no como action de DI) para que las actions
 * de mutación reutilicen la lectura DENTRO de la misma transacción que el
 * subsiguiente UPDATE (snapshot isolation).
 */
export async function findCustomerInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
): Promise<Customer> {
  const customer = await manager.findOne(Customer, {
    where: { id: String(id), company_id: String(companyId) },
  });
  if (!customer) {
    throw new NotFoundException('Cliente no encontrado');
  }
  return customer;
}
