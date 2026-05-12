import type { Logger } from '@nestjs/common';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation`. Se detecta al crear o actualizar
 * credenciales para traducir la race condition `username-tomado` a 409 con
 * `code = USERNAME_TAKEN`.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Nombre del CHECK constraint en DB que enforza:
 *   login_enabled = true ⇒ username NOT NULL AND password NOT NULL
 *
 * El service lo valida en pre-flight; si un escenario raro lo viola (update
 * parcial concurrente), Postgres rechaza y se atrapa por nombre del constraint
 * para devolver 400 con mensaje legible.
 */
export const CHK_LOGIN_REQUIRES_CREDENTIALS = 'chk_employees_login_requires_credentials';

/**
 * Nombre del UNIQUE index parcial sobre `username` (GLOBAL, no per-company).
 * Justificación en la migración y en la skill `multi-tenant-rules`. Se detecta
 * por nombre para no confundirlo con un UNIQUE de otra tabla en el mismo catch
 * genérico.
 */
export const IDX_USERNAME_UNIQUE = 'idx_employees_username_unique';

/**
 * Traduce errores de Postgres a `HttpException`s con mensaje legible. Llamada
 * desde los catches de save/update para no propagar SQL al cliente.
 *
 * NO re-lanza: si no matchea, retorna sin hacer nada y deja que el caller
 * relance el error original. Esto preserva los `instanceof` downstream.
 */
export function translateEmployeeConstraintError(error: unknown, logger: Logger): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }

  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
    detail?: string;
  };

  if (pgError.code === PG_UNIQUE_VIOLATION && pgError.constraint === IDX_USERNAME_UNIQUE) {
    throw new ConflictException({
      message: 'Username ya está en uso',
      payload: { code: 'USERNAME_TAKEN' },
    });
  }

  if (pgError.constraint === CHK_LOGIN_REQUIRES_CREDENTIALS) {
    // Defensa de última línea. El service ya valida esto en pre-flight, pero
    // si por alguna razón llegamos aquí, devolvemos 400 amigable en vez de 500.
    logger.warn(
      `CHECK ${CHK_LOGIN_REQUIRES_CREDENTIALS} disparado — escenario inesperado: ${pgError.detail ?? pgError.message}`,
    );
    throw new BadRequestException(
      'No se puede dejar al empleado sin credenciales mientras tenga login habilitado',
    );
  }
}
