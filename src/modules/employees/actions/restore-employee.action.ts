import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Employee } from '../entities/employee.entity';
import { findEmployeeInCompany } from '../internal/employee-lookups';

/**
 * Restaura un empleado archivado (`is_archived = false`). Vuelve a aparecer en
 * el listado por defecto.
 *
 * NO re-habilita el login: `login_enabled` queda como estaba (false, porque
 * archivar lo apagó). Devolver el acceso es una decisión explícita del owner
 * vía `PUT /employees/:id/toggle-login`. Restaurar solo revierte la baja
 * lógica, no la revocación de acceso — así el owner controla en dos pasos
 * separados "traer de vuelta al empleado" y "darle acceso al sistema".
 *
 * Idempotente: si el empleado no estaba archivado, el UPDATE es un no-op y se
 * devuelve el estado actual sin error.
 *
 * `actorId` es el `user_id` del owner autenticado; se usa SOLO para el audit
 * log.
 */
@Injectable()
export class RestoreEmployeeAction {
  private readonly logger = new Logger(RestoreEmployeeAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, actorId: number): Promise<Employee> {
    const updated = await this.dataSource.transaction<Employee>(async (manager) => {
      await findEmployeeInCompany(manager, id, companyId);

      await manager.update(
        Employee,
        { id: String(id), company_id: String(companyId) },
        { is_archived: false },
      );

      return findEmployeeInCompany(manager, id, companyId);
    });

    this.logger.log({
      event: 'employee.restored',
      actorId,
      targetEmployeeId: id,
      companyId,
      action: 'restore',
    });

    return updated;
  }
}
