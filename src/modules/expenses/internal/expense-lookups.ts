import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Expense } from '../entities/expense.entity';

/**
 * Helpers internos del módulo `expenses`. Centralizan lookups dentro del
 * tenant para que ningún caller olvide el filtro `company_id`.
 */

/**
 * Lookup por id dentro de la company. Lanza NotFoundException si no existe o
 * pertenece a otra company — anti-enumeración cross-tenant.
 *
 * `includeArchived` controla si gastos anulados se devuelven (default true,
 * porque mutaciones de anulación necesitan leer rows ya archivados para
 * validar idempotencia; el listado público filtra explícitamente).
 */
export async function findExpenseInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
  options: { includeArchived?: boolean } = {},
): Promise<Expense> {
  const where: { id: string; company_id: string; is_archived?: boolean } = {
    id: String(id),
    company_id: String(companyId),
  };
  if (options.includeArchived === false) {
    where.is_archived = false;
  }

  const expense = await manager.findOne(Expense, { where });
  if (!expense) {
    throw new NotFoundException('Gasto no encontrado');
  }
  return expense;
}
