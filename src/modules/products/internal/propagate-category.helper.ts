import type { EntityManager } from 'typeorm';

import { Product } from '../entities/product.entity';

/**
 * Propaga la CATEGORÍA de un producto BASE a TODAS sus presentaciones (hijos
 * por `parent_id`).
 *
 * Regla de negocio: una presentación está amarrada a la categoría de su base
 * (el form de presentación ni siquiera la deja elegir: hereda la del padre).
 * Cuando el base cambia de categoría, toda la familia lo sigue en la misma
 * transacción — sin esto había que abrir y re-guardar cada presentación.
 *
 * Idempotente y multi-tenant (todo filtra por `company_id`). Las presentaciones
 * son hojas, así que basta un nivel.
 */
export async function propagateCategoryToChildren(args: {
  manager: EntityManager;
  companyId: number;
  parentId: number;
  /** category_id final del base (null = sin categoría). */
  categoryId: number | null;
}): Promise<{ updatedChildren: number }> {
  const { manager, companyId, parentId, categoryId } = args;

  const result = await manager.update(
    Product,
    { parent_id: String(parentId), company_id: String(companyId) },
    { category_id: categoryId !== null ? String(categoryId) : null },
  );

  return { updatedChildren: result.affected ?? 0 };
}
