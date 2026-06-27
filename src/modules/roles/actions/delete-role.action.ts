import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Role } from '../entities/role.entity';
import { assertRoleEditable } from '../internal/role-constraint-errors';
import { findRoleInCompany } from '../internal/role-lookups';

/**
 * Elimina un rol personalizado de la company.
 *
 *   - Si `is_system = true` → 422 (los roles de fábrica no se borran).
 *   - Al borrar un rol no-sistema, los empleados con ese `role_id` quedan en
 *     `role_id = NULL` automáticamente (FK `ON DELETE SET NULL`); pasan al
 *     fallback de permisos legacy.
 *
 * Defensa en profundidad: el DELETE filtra por `{ id, company_id }`
 * (aislamiento multi-tenant). La pre-lectura + el DELETE comparten el manager
 * transaccional.
 */
@Injectable()
export class DeleteRoleAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const role = await findRoleInCompany(manager, id, companyId);

      // Rol inmutable ('Administrador') → 422 (code ROLE_NOT_EDITABLE), antes
      // que el check de sistema: un rol inmutable nunca se borra, ni el owner.
      assertRoleEditable(role);

      if (role.is_system) {
        throw new UnprocessableEntityException('No se puede eliminar un rol de sistema');
      }

      // FK employees.role_id ON DELETE SET NULL: los empleados quedan sin rol.
      await manager.delete(Role, { id: String(id), company_id: String(companyId) });
    });
  }
}
