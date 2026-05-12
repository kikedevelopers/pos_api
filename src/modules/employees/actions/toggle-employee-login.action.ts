import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Employee } from '../entities/employee.entity';
import { translateEmployeeConstraintError } from '../internal/constraint-errors';
import { findEmployeeInCompany } from '../internal/employee-lookups';

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
        throw new UnprocessableEntityException(
          'Debe configurar username y password antes de habilitar el login',
        );
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

      return findEmployeeInCompany(manager, id, companyId);
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
