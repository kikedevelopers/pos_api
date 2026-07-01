import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  DEFAULT_SYSTEM_ACCESS_ROLE_NAME,
  findRoleIdByName,
} from '@/modules/roles/internal/system-roles';

import { Employee } from '../entities/employee.entity';
import { translateEmployeeConstraintError } from '../internal/constraint-errors';
import { ensureMirrorUserForEmployee } from '../internal/ensure-mirror-user-for-employee.helper';
import { findEmployeeInCompany } from '../internal/employee-lookups';
import { resolveRoleIdOnGrantAccess } from '../internal/role-assignment';

/**
 * Habilita o deshabilita el acceso del employee a `POST /auth/user`.
 *
 *   - `enabled = true` y el employee no tiene credenciales → 422. El cliente
 *     debe primero asignar credenciales por `PUT /employees/:id/credentials`.
 *   - `enabled = false` se acepta siempre (revocación).
 *
 * El CHECK constraint en DB también protege: si por algún bug el action
 * intentara habilitar login sin credenciales, Postgres rechaza y atrapamos el
 * error por nombre del constraint.
 *
 * `actorId` es el `user_id` del owner autenticado; se usa SOLO para el audit
 * log.
 *
 * Transacción: la verificación de credenciales (pre-flight) + el UPDATE +
 * el re-fetch comparten el mismo manager. Sin transacción, un update
 * concurrente que nullifique credenciales entre el pre-flight y el UPDATE
 * dejaría el row en estado inválido (lo previene el CHECK, pero la
 * transacción evita el 500 ruidoso).
 */
@Injectable()
export class ToggleEmployeeLoginAction {
  private readonly logger = new Logger(ToggleEmployeeLoginAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    id: number,
    enabled: boolean,
    companyId: number,
    actorId: number,
  ): Promise<Employee> {
    const updated = await this.dataSource.transaction<Employee>(async (manager) => {
      const employee = await findEmployeeInCompany(manager, id, companyId);

      if (enabled === true && (!employee.username || !employee.password)) {
        // 422 (no 400): el estado del employee es inconsistente con la
        // operación, no la entrada. PlacePos también devuelve este código
        // para el mismo escenario. El payload incluye `code: MISSING_CREDENTIALS`
        // para que el cliente UI pueda mostrar el flujo correcto (asignar
        // credenciales primero).
        throw new UnprocessableEntityException({
          message: 'Debe configurar username y password antes de habilitar el login',
          payload: { code: 'MISSING_CREDENTIALS' },
        });
      }

      try {
        await manager.update(
          Employee,
          { id: String(id), company_id: String(companyId) },
          { login_enabled: enabled },
        );
      } catch (error) {
        translateEmployeeConstraintError(error, this.logger);
        throw error;
      }

      const refreshed = await findEmployeeInCompany(manager, id, companyId);

      // Conceder acceso ⇒ garantizar rol. Si el employee no tenía rol asignado,
      // al habilitar el login le damos el rol por defecto 'Vendedor' (el más
      // restringido). NUNCA pisamos un rol ya asignado, y al deshabilitar NO
      // borramos el rol (re-habilitar lo conserva). Simetría con la creación:
      // el rol solo existe cuando hay acceso al sistema. La decisión vive en
      // `resolveRoleIdOnGrantAccess` (undefined = no tocar).
      if (enabled === true && refreshed.role_id === null) {
        const roleIdToAssign = resolveRoleIdOnGrantAccess(
          enabled,
          refreshed.role_id,
          await findRoleIdByName(manager, companyId, DEFAULT_SYSTEM_ACCESS_ROLE_NAME),
        );
        if (roleIdToAssign !== undefined) {
          await manager.update(
            Employee,
            { id: String(id), company_id: String(companyId) },
            { role_id: roleIdToAssign },
          );
          refreshed.role_id = roleIdToAssign;
        }
      }

      // Side-effect del flujo OFF→ON: si el employee aún no tiene User
      // espejo, lo materializamos AQUÍ (no esperamos al primer login). Esto
      // permite que las acciones administrativas que tocan caja
      // (set-cash-base, adjust-cash) funcionen inmediatamente tras habilitar
      // el login, sin requerir que el employee haga login primero.
      //
      // Si `enabled = false`: NO se borra el user_id. La fila de `users`
      // queda, y los `cash_register_log` / `financial_movement` históricos
      // que apuntan a `users.id` permanecen consistentes. El employee no
      // podrá volver a hacer login hasta que se re-habilite, pero su
      // historia queda íntegra.
      if (enabled === true && refreshed.user_id === null) {
        await ensureMirrorUserForEmployee({
          manager,
          employee: refreshed,
          companyId,
        });
        // ensureMirrorUserForEmployee mutó refreshed.user_id; lo devolvemos
        // como está. Una segunda lectura sería redundante.
      }

      return refreshed;
    });

    // Audit log post-commit. Registra cambio de estado de login del employee.
    this.logger.log({
      event: 'employee.credentials_updated',
      actorId,
      targetEmployeeId: id,
      companyId,
      action: 'toggleLogin',
    });

    return updated;
  }
}
