import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Role } from '../entities/role.entity';

/**
 * Lookup de un rol por id DENTRO de una company usando un `EntityManager`
 * (transaccional o no). Lanza `NotFoundException` si no existe o pertenece a
 * otra company (no se distingue — anti-enumeración + aislamiento multi-tenant).
 *
 * Se expone como helper interno para que las actions de mutación reutilicen la
 * lectura dentro de la MISMA transacción que el subsiguiente UPDATE/DELETE
 * (snapshot isolation).
 */
export async function findRoleInCompany(
  manager: EntityManager,
  id: number,
  companyId: number,
): Promise<Role> {
  const role = await manager.findOne(Role, {
    where: { id: String(id), company_id: String(companyId) },
  });
  if (!role) {
    throw new NotFoundException('Rol no encontrado');
  }
  return role;
}

/**
 * Cuenta los empleados ACTIVOS (`is_archived = false`) asignados a un rol
 * dentro de una company. Usa la FK `employees.role_id` (índice
 * `idx_employees_role_id`) + `company_id` (índice `idx_employees_company_id`).
 */
export async function countActiveEmployeesForRole(
  manager: EntityManager,
  roleId: number,
  companyId: number,
): Promise<number> {
  const rows: Array<{ n: number }> = await manager.query(
    `SELECT COUNT(*)::int AS n
     FROM employees
     WHERE role_id = $1 AND company_id = $2 AND is_archived = false`,
    [String(roleId), String(companyId)],
  );
  return rows[0]?.n ?? 0;
}
