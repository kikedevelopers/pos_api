import { ConflictException, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { QueryFailedError } from 'typeorm';

import { User, UserType } from '@/modules/users/entities/user.entity';

import { Employee } from '../entities/employee.entity';

const logger = new Logger('EnsureMirrorUserForEmployee');

const PG_UNIQUE_VIOLATION = '23505';
const IDX_USERS_EMAIL_UNIQUE = 'idx_users_email_unique';
const IDX_EMPLOYEES_USER_ID_UNIQUE = 'idx_employees_user_id_unique';

/**
 * Construye el email sintético del User espejo.
 *
 * --------------------------------------------------------------------------
 * Decisión de diseño: incluir `companyId` en el local-part
 * --------------------------------------------------------------------------
 *
 * PlacePos (single-tenant) usa `${username}@local.placepos`. En multi-tenant
 * cloud, dos companies pueden tener dos employees con el mismo `username`
 * **sin colisionar** en `employees.username` (UNIQUE GLOBAL parcial — solo
 * un employee con ese username puede existir activo en toda la tabla,
 * porque PlacePos asume usernames únicos por instalación).
 *
 * SIN EMBARGO: `users.email` es UNIQUE GLOBAL absoluto. Si en el futuro se
 * relaja el UNIQUE de `employees.username` a per-company, dos espejos
 * intentarían usar el mismo email → conflicto.
 *
 * Para blindar el contrato del User espejo frente a esa eventualidad y
 * mantener la trazabilidad operativa (saber a qué company pertenece cada
 * espejo con solo mirar el email), incluimos `companyId` en el local-part:
 *
 *     `${username}.${companyId}@local.placepos`
 *
 * El frontend nunca ve este email — solo se usa para satisfacer el NOT NULL
 * UNIQUE de `users.email`. Paridad PlacePos: el sufijo `@local.placepos`
 * se preserva para que cualquier tooling de reportes que filtre por dominio
 * siga funcionando.
 */
function buildMirrorEmail(username: string, companyId: number): string {
  return `${username}.${companyId}@local.placepos`;
}

interface EnsureMirrorParams {
  manager: EntityManager;
  employee: Employee;
  companyId: number;
}

/**
 * Crea o sincroniza el User espejo del Employee.
 *
 * --------------------------------------------------------------------------
 * Comportamiento
 * --------------------------------------------------------------------------
 *
 *   1. **Si `employee.user_id` es null**: crea un User con
 *        - `email`: `${username}.${companyId}@local.placepos`
 *        - `type`: `'employee'` (valor extendido del enum `user_type` en la
 *          migración `1747010320000-extend-user-type-enum-with-employee.ts`).
 *        - `password`: el hash del Employee (REUSO, NO se rehashea).
 *        - `name`, `lastname` del Employee (`lastname=''` si no tiene).
 *        - `company_id` del Employee.
 *      Luego setea `Employee.user_id` con el id del User recién creado.
 *
 *   2. **Si `employee.user_id` ya existe**: re-lee el User y sincroniza:
 *        - `email` si el username cambió (`buildMirrorEmail` con el nuevo).
 *        - `password` si el hash del Employee cambió (sync completa).
 *        - `name`, `lastname` si cambiaron.
 *      Devuelve el User actualizado.
 *
 * --------------------------------------------------------------------------
 * Concurrencia y errores
 * --------------------------------------------------------------------------
 *
 *   - DEBE invocarse dentro de `dataSource.transaction(...)`. El UPDATE a
 *     `employees.user_id` + INSERT a `users` viven en el mismo manager.
 *
 *   - 23505 sobre `idx_users_email_unique`: en multi-tenant, otro proceso
 *     podría haber creado un User con el mismo email sintético (improbable
 *     porque incluimos `companyId`, pero defensa en profundidad). Lanzamos
 *     `ConflictException` con `code='EMAIL_TAKEN'`.
 *
 *   - 23505 sobre `idx_employees_user_id_unique`: el employee.user_id ya
 *     fue tomado por una transacción concurrente (race entre dos logins del
 *     mismo employee). Re-leemos el Employee y devolvemos el User existente.
 *
 *   - Cualquier otro error se re-lanza sin tocar.
 */
export async function ensureMirrorUserForEmployee(params: EnsureMirrorParams): Promise<User> {
  const { manager, employee, companyId } = params;

  if (!employee.username || !employee.password) {
    // Precondición: el Employee debe tener credenciales (username + hash).
    // Sin ellas no podemos construir el email ni reusar el password. Este
    // check defensivo refleja la invariante del CHECK constraint en DB.
    throw new Error('ensureMirrorUserForEmployee: el Employee debe tener username y password');
  }

  // Caso 2: ya hay user_id → re-sincronizar campos editables.
  if (employee.user_id !== null) {
    const existing = await manager.findOne(User, {
      where: { id: employee.user_id },
    });
    if (existing) {
      const desiredEmail = buildMirrorEmail(employee.username, companyId);
      const patch: Partial<User> = {};
      if (existing.email !== desiredEmail) {
        patch.email = desiredEmail;
      }
      if (existing.password !== employee.password) {
        patch.password = employee.password;
      }
      if (existing.name !== employee.name) {
        patch.name = employee.name;
      }
      // Employees no tienen lastname en el contrato PlacePos: usamos ''.
      if (existing.lastname !== '') {
        patch.lastname = '';
      }
      if (Object.keys(patch).length > 0) {
        try {
          await manager.update(User, { id: existing.id }, patch);
        } catch (error) {
          rethrowKnownConflicts(error);
          throw error;
        }
      }
      return manager.findOneOrFail(User, { where: { id: existing.id } });
    }
    // user_id colgado (FK ON DELETE SET NULL ya lo habría limpiado, pero
    // por robustez si llegamos aquí, caemos al flujo de creación).
    logger.warn(
      `Employee ${employee.id} tiene user_id=${employee.user_id} pero el User no existe; recreando espejo`,
    );
  }

  // Caso 1: crear User espejo nuevo.
  const newUser = manager.create(User, {
    name: employee.name,
    lastname: '', // Employees no tienen lastname (paridad PlacePos).
    email: buildMirrorEmail(employee.username, companyId),
    password: employee.password, // REUSO directo del hash argon2 del Employee.
    type: UserType.EMPLOYEE,
    company_id: String(companyId),
    balance: 0,
  });

  let savedUser: User;
  try {
    savedUser = await manager.save(User, newUser);
  } catch (error) {
    rethrowKnownConflicts(error);
    throw error;
  }

  // Vincular el employee al user espejo. Race-safe: si otra transacción ya
  // pobló el user_id, el UNIQUE parcial dispara y traducimos a re-fetch.
  try {
    await manager.update(
      Employee,
      { id: employee.id, company_id: String(companyId) },
      { user_id: savedUser.id },
    );
  } catch (error) {
    if (isUniqueViolation(error, IDX_EMPLOYEES_USER_ID_UNIQUE)) {
      // Race: otra TX ya hizo el binding. Re-leemos el Employee y devolvemos
      // el User que ganó la carrera.
      const refreshed = await manager.findOne(Employee, {
        where: { id: employee.id, company_id: String(companyId) },
      });
      if (refreshed?.user_id) {
        const winner = await manager.findOne(User, {
          where: { id: refreshed.user_id },
        });
        if (winner) {
          // Limpiamos el User huérfano que acabamos de crear. NO crítico si
          // falla (queda como fila huérfana detectable por un GC futuro).
          await manager.delete(User, { id: savedUser.id }).catch(() => undefined);
          return winner;
        }
      }
    }
    throw error;
  }

  // Mutamos in-memory el snapshot del employee para que el caller no tenga
  // que re-leer si solo necesita el user_id.
  employee.user_id = savedUser.id;
  return savedUser;
}

function isUniqueViolation(error: unknown, constraintName: string): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
  };
  return pgError.code === PG_UNIQUE_VIOLATION && pgError.constraint === constraintName;
}

function rethrowKnownConflicts(error: unknown): void {
  if (isUniqueViolation(error, IDX_USERS_EMAIL_UNIQUE)) {
    throw new ConflictException({
      message: 'El email sintético del usuario espejo ya está en uso',
      payload: { code: 'EMAIL_TAKEN' },
    });
  }
}
