import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

/**
 * Lookup por id dentro de una company. Lanza `NotFoundException` si no existe
 * o pertenece a otra company — anti-enumeración cross-tenant.
 *
 * NO filtra `is_archived`: las mutaciones operan sobre activos y archivados.
 * El listado público filtra por defecto.
 *
 * Helper interno para reutilizar la lectura DENTRO de la misma transacción
 * que el UPDATE subsiguiente (snapshot isolation).
 */
export async function findSupplierInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
): Promise<Supplier> {
  const supplier = await manager.findOne(Supplier, {
    where: { id: String(id), company_id: String(companyId) },
  });
  if (!supplier) {
    throw new NotFoundException('Proveedor no encontrado');
  }
  return supplier;
}
