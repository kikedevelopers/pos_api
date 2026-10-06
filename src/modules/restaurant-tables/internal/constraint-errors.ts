import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';
export const IDX_RESTAURANT_TABLE_NAME_UNIQUE = 'idx_restaurant_tables_company_name_unique';

/**
 * Traduce la colisión de nombre de mesa per-company a 409 con un `code`
 * branchable. Si el error NO es UNIQUE, no re-lanza.
 */
export function translateRestaurantTableConstraintError(error: unknown): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }
  const pgError = error as QueryFailedError & { code?: string };
  if (pgError.code !== PG_UNIQUE_VIOLATION) {
    return;
  }
  throw new ConflictException({
    message: 'Ya existe una mesa con este nombre.',
    payload: { code: 'TABLE_NAME_TAKEN' },
  });
}
