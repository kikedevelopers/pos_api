import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Product, ProductType } from '@/modules/products/entities/product.entity';

import { resolveAccessibleProducts } from './accessible-products.helper';

/**
 * Código que el front (`placepos`) matchea para mostrar el mensaje de solo
 * lectura de un producto compartido, en vez del 404 genérico.
 */
export const SHARED_PRODUCT_READONLY_CODE = 'SHARED_PRODUCT_READONLY';

/**
 * Mensaje único de "producto compartido = solo lectura en la sucursal". Se
 * mantiene alineado con `SHARED_READONLY_MSG` del front
 * (`ProductRowActions.tsx`).
 */
export const SHARED_PRODUCT_READONLY_MESSAGE =
  'Este producto es compartido desde el negocio principal: solo puede editarse desde el principal, no desde la sucursal.';

/**
 * FASE 2 (COMPARTIR) — Guarda de escritura. Un producto COMPARTIDO por el
 * principal es visible/vendible en la sucursal pero NO editable desde ella: su
 * fila (y su stock) siguen siendo del principal, que es la única fuente de
 * verdad. Sin esta guarda, una mutación (`PUT /inventory/:id`) sobre un id
 * compartido caía en el `findProductInCompany` filtrado por `company_id` y
 * devolvía un 404 "Producto no encontrado" — confuso: el producto SÍ existe y
 * se ve en la lista, solo que no es de esta company.
 *
 * Aquí distinguimos ese caso y lanzamos un `ForbiddenException` (403) con un
 * mensaje claro y un `code` que el front usa para informar al usuario. Si el id
 * NO es accesible como compartido (ajeno de verdad, o propio), esta función es
 * un no-op y el caller sigue su curso normal (el 404 anti-enumeración para un
 * ajeno, o la edición para un producto propio).
 *
 * Reutiliza `resolveAccessibleProducts` para no duplicar las reglas del share
 * (company-level, product-level, presentación de un compartido).
 */
export async function assertProductNotShared(
  manager: EntityManager,
  id: number,
  companyId: number,
): Promise<void> {
  const access = await resolveAccessibleProducts(manager, companyId, [id]);
  const ref = access.get(id);
  if (ref && ref.isShared) {
    throw new ForbiddenException({
      message: SHARED_PRODUCT_READONLY_MESSAGE,
      payload: { code: SHARED_PRODUCT_READONLY_CODE },
    });
  }
}

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

/**
 * Guard: una presentación no puede colgar de un COMBO. El combo no tiene stock
 * ni empaque propios, así que no hay nada de dónde derivar la variante.
 * No-op si `parentId` es null (producto base). Espejo PlacePos.
 */
export async function assertParentIsNotCombo(
  manager: EntityManager,
  parentId: number | null | undefined,
  companyId: number,
): Promise<void> {
  if (parentId === null || parentId === undefined) {
    return;
  }
  const parent = await manager.findOne(Product, {
    where: { id: String(parentId), company_id: String(companyId) },
    select: { id: true, name: true, product_type: true },
  });
  if (parent?.product_type === ProductType.COMBO) {
    throw new BadRequestException(
      `"${parent.name}" es un combo: no puede tener presentaciones. Elige un producto base.`,
    );
  }
}
