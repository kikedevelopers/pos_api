import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation`.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Nombre del índice UNIQUE parcial sobre `(company_id, lower(btrim(name)))`
 * en `categories`.
 */
export const IDX_CATEGORY_NAME_UNIQUE = 'idx_categories_company_name_unique';

/**
 * Traduce el error de colisión de nombre per-company a 409 Conflict con un
 * `code` específico que el cliente puede branchear.
 *
 * Si el error NO es una violación UNIQUE, no re-lanza — el caller deja que el
 * error original suba.
 */
export function translateCategoryConstraintError(error: unknown): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }

  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
    detail?: string;
  };

  if (pgError.code !== PG_UNIQUE_VIOLATION) {
    return;
  }

  const constraint = pgError.constraint ?? '';
  const detail = pgError.detail ?? '';

  if (constraint === IDX_CATEGORY_NAME_UNIQUE || detail.includes('(name)')) {
    throw new ConflictException({
      message: 'Ya existe una categoría con este nombre.',
      payload: { code: 'CATEGORY_NAME_TAKEN' },
    });
  }

  throw new ConflictException({
    message: 'Ya existe una categoría con estos datos.',
    payload: { code: 'CATEGORY_DUPLICATE' },
  });
}
