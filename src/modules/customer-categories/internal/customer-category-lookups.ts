import { BadRequestException, NotFoundException } from '@nestjs/common';
import { type EntityManager } from 'typeorm';

import { CustomerCategory } from '../entities/customer-category.entity';

/**
 * Lookup por id dentro de una company. Lanza `NotFoundException` si no
 * existe o pertenece a otra company — anti-enumeración cross-tenant.
 *
 * NO filtra `is_archived`: mutaciones que rechacen archivadas lo enforzarán
 * explícitamente.
 */
export async function findCustomerCategoryInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
): Promise<CustomerCategory> {
  const category = await manager.findOne(CustomerCategory, {
    where: { id: String(id), company_id: String(companyId) },
  });
  if (!category) {
    throw new NotFoundException('Categoría de cliente no encontrada');
  }
  return category;
}

/**
 * Valida que `category_id` referencie una categoría de cliente ACTIVA de la
 * company antes de asociarla a un customer. La invoca el create/update de
 * customers DENTRO de su transacción para que la validación y el INSERT/UPDATE
 * sean atómicos (evita TOCTOU con un archive concurrente).
 *
 *   - `id` null/undefined → devuelve `null` (cliente sin categoría). El caller
 *     interpreta `null` como "limpiar la categoría".
 *   - Categoría inexistente, de otra company o archivada → 400 (el cliente
 *     mandó un id inválido; no es un 404 del customer). Mensaje estable.
 *
 * Devuelve el id normalizado a `string` (forma en que TypeORM espera la FK
 * bigint) o `null`.
 */
export async function resolveCustomerCategoryId(
  manager: EntityManager,
  id: number | null | undefined,
  companyId: number,
): Promise<string | null> {
  if (id === null || id === undefined) {
    return null;
  }

  const category = await manager.findOne(CustomerCategory, {
    where: { id: String(id), company_id: String(companyId) },
  });

  if (!category || category.is_archived) {
    throw new BadRequestException('La categoría de cliente indicada no existe o está archivada');
  }

  return category.id;
}
