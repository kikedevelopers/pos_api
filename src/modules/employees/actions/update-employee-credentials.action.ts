import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';

import { ARGON2_OPTIONS } from '@/common/utils/argon2-options';

import type { UpdateCredentialsDto } from '../dto/update-credentials.dto';
import { Employee } from '../entities/employee.entity';
import { translateEmployeeConstraintError } from '../internal/constraint-errors';
import { ensureMirrorUserForEmployee } from '../internal/ensure-mirror-user-for-employee.helper';
import { findEmployeeInCompany } from '../internal/employee-lookups';

/**
 * Actualiza username y/o password.
 *
 *   - Si ambos vienen ausentes → 400.
 *   - `username` colisionado → 409 `USERNAME_TAKEN`.
 *   - `password` se hashea con argon2id (mismas opciones que el AuthService).
 *   - Nunca puede dejar el employee en estado inválido (login_enabled = true
 *     sin credenciales) porque este action solo SETEA credenciales, no las
 *     nullifica.
 *
 * `actorId` es el `user_id` del owner autenticado (extraído del JWT en el
 * controller). Se usa SOLO para el audit log; nunca se persiste aquí.
 *
 * Transacción: la verificación de tenancy + el UPDATE + el re-fetch comparten
 * el mismo manager. El hashing argon2 ocurre FUERA del callback para no
 * mantener una conexión abierta durante el cómputo CPU-bound (~50-100ms).
 */
@Injectable()
export class UpdateEmployeeCredentialsAction {
  private readonly logger = new Logger(UpdateEmployeeCredentialsAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    id: number,
    dto: UpdateCredentialsDto,
    companyId: number,
    actorId: number,
  ): Promise<Employee> {
    if (!dto.username && !dto.password) {
      throw new BadRequestException('Al menos uno de username o password debe enviarse');
    }

    // Validar tenancy ANTES de hashear (no gastar CPU si va a fallar). Read
    // breve fuera de la transacción; se reconfirma DENTRO de la transacción
    // a través de `findEmployeeInCompany`.
    // (El re-fetch al final del callback transaccional es el snapshot final.)

    const hashedPassword =
      dto.password !== undefined ? await argon2.hash(dto.password, ARGON2_OPTIONS) : undefined;

    const updated = await this.dataSource.transaction<Employee>(async (manager) => {
      await findEmployeeInCompany(manager, id, companyId);

      const patch: Partial<Employee> = {};
      if (dto.username !== undefined) {
        patch.username = dto.username;
      }
      if (hashedPassword !== undefined) {
        patch.password = hashedPassword;
      }

      try {
        await manager.update(Employee, { id: String(id), company_id: String(companyId) }, patch);
      } catch (error) {
        translateEmployeeConstraintError(error, this.logger);
        throw error;
      }

      const refreshed = await findEmployeeInCompany(manager, id, companyId);

      // Sincronizar el User espejo si ya existe. Cambios a propagar:
      //   - username  → email del espejo (`${newUsername}.${companyId}@local.placepos`).
      //   - password  → hash del espejo (REUSO del hash recién generado).
      //
      // Si el employee aún NO tiene espejo (login no se ha activado nunca),
      // NO lo creamos aquí — solo se crea cuando login_enabled pasa a true
      // (toggle) o al crear el employee con login. Esto evita crear espejos
      // huérfanos cuando el owner solo está pre-configurando credenciales.
      if (refreshed.user_id !== null && refreshed.username && refreshed.password) {
        await ensureMirrorUserForEmployee({
          manager,
          employee: refreshed,
          companyId,
        });
      }

      return refreshed;
    });

    // Audit log post-commit. NO incluimos username/password/hash — solo IDs y
    // acción. Si la transacción falla, este log NO se emite (correcto).
    this.logger.log({
      event: 'employee.credentials_updated',
      actorId,
      targetEmployeeId: id,
      companyId,
      action: 'updateCredentials',
    });

    return updated;
  }
}
