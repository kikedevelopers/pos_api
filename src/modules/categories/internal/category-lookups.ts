import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Category } from '../entities/category.entity';

/**
 * Lookup por id dentro de una company. Lanza `NotFoundException` si no
 * existe o pertenece a otra company — anti-enumeración cross-tenant.
 *
 * NO filtra `is_archived`: mutaciones que rechacen archivadas lo enforzarán
 * explícitamente.
 */
export async function findCategoryInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
): Promise<Category> {
  const category = await manager.findOne(Category, {
    where: { id: String(id), company_id: String(companyId) },
  });
  if (!category) {
    throw new NotFoundException('Categoría no encontrada');
  }
  return category;
}
