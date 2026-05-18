import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Product } from '@/modules/products/entities/product.entity';

/**
 * Lookup por id dentro de una company con relations `prices` y `packaging`
 * cargadas. Lanza `NotFoundException` si no existe O pertenece a otra
 * company. Anti-enumeración cross-tenant.
 *
 * Por defecto **incluye archivados** porque PlacePos lo hace en
 * `GET /inventory/:id` (devuelve el producto sin filtrar `archived`). Las
 * mutaciones (`update`, `archive`) que rechacen archivados lo enforzarán
 * explícitamente.
 *
 * Recibe `EntityManager` para reutilizar la lectura DENTRO de la
 * transacción del caller.
 */
export async function findProductInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
  options: { withRelations?: boolean; activeOnly?: boolean } = {},
): Promise<Product> {
  const where: Record<string, unknown> = {
    id: String(id),
    company_id: String(companyId),
  };
  if (options.activeOnly === true) {
    where.is_archived = false;
  }

  const product = await manager.findOne(Product, {
    where,
    relations:
      options.withRelations === true
        ? { prices: true, packaging: true, category: true }
        : undefined,
  });

  if (!product) {
    throw new NotFoundException('Producto no encontrado.');
  }
  return product;
}

/**
 * Verifica que `parent_id` (si está presente) sea un producto válido de
 * la MISMA company. Si no existe, lanza 400 (no 404 — el padre no es el
 * recurso de la URL).
 */
export async function assertParentBelongsToCompany(
  manager: EntityManager,
  parentId: number | null | undefined,
  companyId: number,
): Promise<void> {
  if (parentId === null || parentId === undefined) {
    return;
  }
  const parent = await manager.findOne(Product, {
    where: { id: String(parentId), company_id: String(companyId) },
    select: ['id'],
  });
  if (!parent) {
    throw new NotFoundException('Producto padre no encontrado o pertenece a otro negocio.');
  }
}

/**
 * Verifica que `packaging_id` (si está presente) sea un empaque válido de
 * la MISMA company. Se valida que NO esté archivado: asociar un packaging
 * archivado a un producto activo no tendría sentido.
 *
 * Nota: usamos `manager.query(...)` con `count` en lugar de cargar la
 * entidad para no requerir importar `Packaging` aquí (mantenemos el módulo
 * desacoplado).
 */
export async function assertPackagingBelongsToCompany(
  manager: EntityManager,
  packagingId: number | null | undefined,
  companyId: number,
): Promise<void> {
  if (packagingId === null || packagingId === undefined) {
    return;
  }
  const rows = await manager.query<Array<{ id: string }>>(
    `SELECT id FROM packagings
     WHERE id = $1 AND company_id = $2 AND is_archived = false
     LIMIT 1`,
    [packagingId, companyId],
  );
  if (rows.length === 0) {
    throw new NotFoundException('Empaque no encontrado o pertenece a otro negocio.');
  }
}

/**
 * Verifica que `category_id` (si está presente) sea una categoría válida
 * de la MISMA company y no archivada. Espejo de `assertPackagingBelongsToCompany`.
 *
 * Usamos `manager.query` con LIMIT 1 para no acoplar este módulo al import
 * de la entidad `Category` (defensa contra ciclos de módulos). El UNIQUE
 * parcial sobre `(company_id, lower(btrim(name)))` solo cubre activas, así
 * que asignar una categoría archivada a un producto activo no tendría
 * sentido y lo bloqueamos aquí.
 */
export async function assertCategoryBelongsToCompany(
  manager: EntityManager,
  categoryId: number | null | undefined,
  companyId: number,
): Promise<void> {
  if (categoryId === null || categoryId === undefined) {
    return;
  }
  const rows = await manager.query<Array<{ id: string }>>(
    `SELECT id FROM categories
     WHERE id = $1 AND company_id = $2 AND is_archived = false
     LIMIT 1`,
    [categoryId, companyId],
  );
  if (rows.length === 0) {
    throw new NotFoundException('Categoría no encontrada o pertenece a otro negocio.');
  }
}
