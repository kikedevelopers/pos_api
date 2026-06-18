import { NotFoundException } from '@nestjs/common';
import { QueryFailedError, type EntityManager } from 'typeorm';

import { Category } from '../entities/category.entity';
import { PG_UNIQUE_VIOLATION } from './constraint-errors';

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

/**
 * find-or-create de una categoría por NOMBRE, scoped a la company. Espejo de
 * `resolveCategoryIdByName` de PlacePos (`inventoryHelpers.ts`), pero
 * aislado por `company_id`.
 *
 *   - `name` vacío/undefined → `null` (producto sin categoría).
 *   - Match case-insensitive sobre `lower(btrim(name))` de categorías
 *     ACTIVAS de la company (alineado con el índice único parcial
 *     `idx_categories_company_name_unique`).
 *   - Si no existe → la crea y devuelve su id. La tabla `categories` de
 *     pos_api no tiene columnas de auditoría `created_by` (a diferencia de
 *     placepos), así que no las seteamos — paridad con `CreateCategoryAction`.
 *
 * Concurrencia: dos items del mismo lote (o lotes paralelos) pueden intentar
 * crear la misma categoría. El INSERT puede chocar con el índice único
 * parcial (23505); en ese caso re-buscamos y devolvemos el id ganador en
 * lugar de propagar el error — la operación es idempotente por nombre.
 *
 * Debe invocarse DENTRO de la transacción del caller para que la categoría
 * recién creada y el producto que la referencia sean atómicos.
 */
export async function resolveCategoryIdByName(
  manager: EntityManager,
  name: string | undefined | null,
  companyId: number,
): Promise<string | null> {
  const trimmed = name?.trim();
  if (!trimmed) {
    return null;
  }

  const existing = await findActiveCategoryByName(manager, trimmed, companyId);
  if (existing) {
    return existing;
  }

  try {
    const created = await manager.save(
      Category,
      manager.create(Category, {
        company_id: String(companyId),
        name: trimmed,
        is_archived: false,
      }),
    );
    return created.id;
  } catch (error) {
    // Carrera contra otro item que creó la misma categoría primero.
    if (
      error instanceof QueryFailedError &&
      (error as { code?: string }).code === PG_UNIQUE_VIOLATION
    ) {
      const winner = await findActiveCategoryByName(manager, trimmed, companyId);
      if (winner) {
        return winner;
      }
    }
    throw error;
  }
}

// Normaliza un nombre dentro de SQL para comparar sin distinguir mayúsculas NI
// acentos: lower + trim + translate de las vocales acentuadas a su base. Se usa
// translate() puro (no `unaccent`) para no depender de una extensión en prod y
// que la expresión sea determinista. Ambas cadenas tienen la MISMA longitud
// (22) — requisito de translate(). `ñ` se deja intacta (letra propia, no acento).
const ACCENTED = 'áàäâãéèëêíìïîóòöôõúùüû';
const UNACCENTED = 'aaaaaeeeeiiiiooooouuuu';
const normalizeNameSql = (col: string): string =>
  `translate(lower(btrim(${col})), '${ACCENTED}', '${UNACCENTED}')`;

/**
 * Busca el id de una categoría activa de la company por nombre, ignorando
 * mayúsculas Y acentos (p. ej. "BEBIDA" coincide con "bebida", "Bebida" o
 * "Bébida"). Devuelve `null` si no existe.
 */
async function findActiveCategoryByName(
  manager: EntityManager,
  trimmedName: string,
  companyId: number,
): Promise<string | null> {
  const found = await manager
    .getRepository(Category)
    .createQueryBuilder('c')
    .select('c.id', 'id')
    .where('c.company_id = :companyId', { companyId: String(companyId) })
    .andWhere('c.is_archived = false')
    .andWhere(`${normalizeNameSql('c.name')} = ${normalizeNameSql(':name')}`, {
      name: trimmedName,
    })
    .limit(1)
    .getRawOne<{ id: string }>();
  return found?.id ?? null;
}
