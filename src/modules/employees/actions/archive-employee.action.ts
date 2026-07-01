import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Employee } from '../entities/employee.entity';
import { findEmployeeInCompany } from '../internal/employee-lookups';

/**
 * Archiva un empleado (`is_archived = true`). Archivar es una baja lógica: el
 * empleado desaparece del listado por defecto pero su historia (ventas, caja,
 * movimientos) permanece intacta.
 *
 * Efecto secundario CLAVE: archivar REVOCA el acceso. Se fuerza
 * `login_enabled = false` en el mismo UPDATE — un empleado archivado NO puede
 * iniciar sesión. Esto evita el estado inconsistente "archivado pero con login
 * activo" que permitiría autenticarse a alguien dado de baja. NO se borra el
 * `user_id` ni las credenciales: restaurar + re-habilitar (manual) devuelve el
 * acceso sin recrear el usuario espejo.
 *
 * Idempotente: si el empleado ya está archivado, el UPDATE es un no-op y se
 * devuelve el estado actual sin error (paridad con PlacePos y semántica REST
 * de PUT).
 *
 * `actorId` es el `user_id` del owner autenticado; se usa SOLO para el audit
 * log.
 *
 * Transacción: el `findEmployeeInCompany` + el UPDATE + el re-fetch comparten
 * el mismo manager (snapshot isolation) por consistencia con el resto de
 * mutaciones del módulo.
 */
@Injectable()
export class ArchiveEmployeeAction {
  private readonly logger = new Logger(ArchiveEmployeeAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, actorId: number): Promise<Employee> {
    const updated = await this.dataSource.transaction<Employee>(async (manager) => {
      // Lookup dentro de la transacción; 404 si no existe o es de otra company.
      await findEmployeeInCompany(manager, id, companyId);

      await manager.update(
        Employee,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true, login_enabled: false },
      );

      // Re-fetch para devolver el estado post-UPDATE (idempotente si ya estaba
      // archivado: el UPDATE no cambia nada y el re-fetch refleja el estado).
      return findEmployeeInCompany(manager, id, companyId);
    });

    // Audit log post-commit.
    this.logger.log({
      event: 'employee.archived',
      actorId,
      targetEmployeeId: id,
      companyId,
      action: 'archive',
    });

    return updated;
  }
}
