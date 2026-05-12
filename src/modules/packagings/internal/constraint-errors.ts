import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation` — detecta colisión del UNIQUE
 * parcial `idx_packagings_company_name_unique`.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Nombre del UNIQUE index parcial sobre `(company_id, lower(btrim(name)))`.
 * Detecta colisión por nombre dentro del mismo tenant para devolver 409 con
 * `code = PACKAGING_NAME_TAKEN`.
 */
export const IDX_PACKAGING_NAME_UNIQUE = 'idx_packagings_company_name_unique';

/**
 * Traduce errores de Postgres a `HttpException`s con mensaje legible.
 *
 * NO re-lanza: si no matchea, retorna sin hacer nada y deja que el caller
 * relance el error original. Esto preserva los `instanceof` downstream y
 * evita ocultar bugs.
 */
export function translatePackagingConstraintError(error: unknown): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }

  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
    detail?: string;
  };

  if (pgError.code === PG_UNIQUE_VIOLATION && pgError.constraint === IDX_PACKAGING_NAME_UNIQUE) {
    throw new ConflictException({
      message: 'Ya existe un empaque con ese nombre',
      payload: { code: 'PACKAGING_NAME_TAKEN' },
    });
  }
}
