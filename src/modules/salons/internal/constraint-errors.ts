import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/** Postgres SQLSTATE para `unique_violation`. */
export const PG_UNIQUE_VIOLATION = '23505';

/** Índice UNIQUE parcial sobre `(company_id, lower(btrim(name)))` en `salons`. */
export const IDX_SALON_NAME_UNIQUE = 'idx_salons_company_name_unique';

/**
 * Traduce la colisión de nombre de salón per-company a 409 con un `code`
 * branchable. Si el error NO es UNIQUE, no re-lanza (el original sube).
 */
export function translateSalonConstraintError(error: unknown): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }
  const pgError = error as QueryFailedError & { code?: string; constraint?: string };
  if (pgError.code !== PG_UNIQUE_VIOLATION) {
    return;
  }
  throw new ConflictException({
    message: 'Ya existe un salón con este nombre.',
    payload: { code: 'SALON_NAME_TAKEN' },
  });
}
