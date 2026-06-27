import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { AccountKind, UserType } from '@/common/types/jwt-payload.type';
import { Employee } from '@/modules/employees/entities/employee.entity';

import { Role } from '../entities/role.entity';
import {
  isValidPermissionKey,
  LEGACY_EMPLOYEE_PERMISSIONS,
  PERMISSION_KEYS,
  type PermissionKey,
} from '../internal/permission-catalog';

/**
 * Actor del que se resuelven los permisos efectivos. `AuthUser` lo satisface
 * estructuralmente; declaramos una interfaz local para desacoplar la firma de
 * la forma exacta del JWT.
 */
export interface PermissionActor {
  type: UserType;
  account: AccountKind;
  user_id: number;
  company_id: number | null;
}

/**
 * Resuelve la lista de permisos EFECTIVOS de un actor (las keys del catálogo a
 * las que tiene acceso).
 *
 * Reglas:
 *   - `owner` / `superadmin` → TODAS las `PERMISSION_KEYS` (acceso total; no
 *     dependen de la tabla `roles`).
 *   - empleado (`account === 'employee'`) → se busca su `Employee` en la
 *     company del JWT por `user_id`:
 *       · si tiene `role_id` y el rol existe → `role.permissions` (filtradas a
 *         keys válidas).
 *       · si NO tiene `role_id` (o el rol no se encuentra) →
 *         `LEGACY_EMPLOYEE_PERMISSIONS` (fallback de acceso histórico).
 *
 * Multi-tenant: ambas lecturas filtran por `company_id` del actor. Un empleado
 * cuyo `user_id` no pertenezca a la company del JWT cae al fallback legacy
 * (nunca hereda permisos de otra company).
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class ResolveEffectivePermissionsAction {
  constructor(
    @InjectRepository(Employee)
    private readonly employeesRepo: Repository<Employee>,
    @InjectRepository(Role)
    private readonly rolesRepo: Repository<Role>,
  ) {}

  async execute(actor: PermissionActor): Promise<PermissionKey[]> {
    // owner/superadmin: acceso total, sin tocar DB.
    if (actor.type === 'owner' || actor.type === 'superadmin') {
      return [...PERMISSION_KEYS];
    }

    // A partir de aquí: empleado. Sin company (no debería ocurrir para un
    // empleado) → fallback legacy por seguridad.
    if (actor.company_id === null) {
      return [...LEGACY_EMPLOYEE_PERMISSIONS];
    }

    const employee = await this.employeesRepo.findOne({
      where: {
        user_id: String(actor.user_id),
        company_id: String(actor.company_id),
        is_archived: false,
      },
    });

    // Sin empleado o sin rol personalizado → permisos legacy.
    if (!employee || employee.role_id === null) {
      return [...LEGACY_EMPLOYEE_PERMISSIONS];
    }

    const role = await this.rolesRepo.findOne({
      where: { id: employee.role_id, company_id: String(actor.company_id) },
    });

    // El rol referenciado ya no existe (carrera con un DELETE) → legacy.
    if (!role) {
      return [...LEGACY_EMPLOYEE_PERMISSIONS];
    }

    return (role.permissions ?? []).filter(isValidPermissionKey);
  }
}
