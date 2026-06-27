import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateRoleDto } from '../dto/update-role.dto';
import { Role } from '../entities/role.entity';
import { isValidPermissionKey, type PermissionKey } from '../internal/permission-catalog';
import { translateRoleConstraintError } from '../internal/role-constraint-errors';
import { countActiveEmployeesForRole, findRoleInCompany } from '../internal/role-lookups';

/** Resultado del update: el rol actualizado + su conteo de empleados activos. */
export interface UpdateRoleResult {
  role: Role;
  employeeCount: number;
}

/**
 * Edita `name`/`color`/`icon`/`permissions` de un rol de la company. Permitido
 * también sobre roles de sistema (`is_system = true`) — el owner puede ajustar
 * qué hace 'Cajero' — pero el flag `is_system` NUNCA se modifica (no está en el
 * DTO y el patch no lo incluye).
 *
 * Defensa en profundidad: el UPDATE filtra por `{ id, company_id }` en su WHERE
 * (aislamiento multi-tenant). La pre-lectura + el UPDATE + el re-fetch comparten
 * el manager transaccional (snapshot isolation).
 *
 * Nombre duplicado por company → 409 vía índice único funcional.
 */
@Injectable()
export class UpdateRoleAction {
  private readonly logger = new Logger(UpdateRoleAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, dto: UpdateRoleDto, companyId: number): Promise<UpdateRoleResult> {
    return this.dataSource.transaction<UpdateRoleResult>(async (manager) => {
      // Pre-validar existencia + tenancy (404 si ajeno/inexistente).
      await findRoleInCompany(manager, id, companyId);

      const patch: Partial<Role> = {};
      if (dto.name !== undefined) {
        patch.name = dto.name.trim();
      }
      if (dto.color !== undefined) {
        patch.color = dto.color ?? null;
      }
      if (dto.icon !== undefined) {
        patch.icon = dto.icon ?? null;
      }
      if (dto.permissions !== undefined) {
        patch.permissions = this.normalizePermissions(dto.permissions);
      }

      if (Object.keys(patch).length > 0) {
        try {
          await manager.update(Role, { id: String(id), company_id: String(companyId) }, patch);
        } catch (error) {
          translateRoleConstraintError(error, this.logger);
          throw error;
        }
      }

      const role = await findRoleInCompany(manager, id, companyId);
      const employeeCount = await countActiveEmployeesForRole(manager, id, companyId);
      return { role, employeeCount };
    });
  }

  /** Deduplica preservando orden y filtra a keys válidas del catálogo. */
  private normalizePermissions(permissions: PermissionKey[]): PermissionKey[] {
    const seen = new Set<string>();
    const result: PermissionKey[] = [];
    for (const key of permissions) {
      if (isValidPermissionKey(key) && !seen.has(key)) {
        seen.add(key);
        result.push(key);
      }
    }
    return result;
  }
}
