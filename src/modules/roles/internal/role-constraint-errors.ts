import type { Logger } from '@nestjs/common';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation`. Se detecta al crear/editar un rol
 * para traducir el choque con el índice único funcional a un 409 amigable.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Nombre del índice único FUNCIONAL `(company_id, lower(btrim(name)))` que
 * impide nombres de rol duplicados (case/trim-insensitive) dentro de una
 * company. Vive como SQL crudo en la migración (índice de expresión). Se
 * detecta por nombre para no confundirlo con un UNIQUE de otra tabla en un
 * catch genérico.
 */
export const IDX_ROLES_NAME_UNIQUE = 'idx_roles_company_name_unique';

/**
 * Código de error programático para un rol inmutable (`is_editable = false`).
 * Lo emiten update/delete cuando el target es el rol de fábrica 'Administrador'
 * (acceso total inamovible). El front lo usa para ocultar acciones de edición.
 */
export const ROLE_NOT_EDITABLE = 'ROLE_NOT_EDITABLE';

/**
 * Falla (422) si el rol no es editable (`is_editable = false`). Aplica a
 * update Y delete: el rol 'Administrador' es INMUTABLE para todos, owner
 * incluido. No depende de `is_system` (es una restricción más fuerte y
 * ortogonal: un rol puede ser de sistema y editable —p.ej. 'Cajero'—).
 */
export function assertRoleEditable(role: { is_editable: boolean }): void {
  if (!role.is_editable) {
    throw new UnprocessableEntityException({
      message: 'Este rol no se puede editar',
      payload: { code: ROLE_NOT_EDITABLE },
    });
  }
}

/**
 * Traduce errores de Postgres del dominio `roles` a `HttpException`s legibles.
 * Llamada desde los catches de save/update.
 *
 * NO re-lanza si no matchea: retorna y deja que el caller relance el error
 * original (preserva `instanceof` downstream).
 */
export function translateRoleConstraintError(error: unknown, logger: Logger): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }

  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
    detail?: string;
  };

  if (pgError.code === PG_UNIQUE_VIOLATION && pgError.constraint === IDX_ROLES_NAME_UNIQUE) {
    logger.warn(`Nombre de rol duplicado por company: ${pgError.detail ?? pgError.message}`);
    throw new ConflictException({
      message: 'Ya existe un rol con ese nombre',
      payload: { code: 'ROLE_NAME_TAKEN' },
    });
  }
}
