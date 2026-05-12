import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation`.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Nombre del UNIQUE index parcial sobre `(company_id, name, account_number)`
 * WHERE `is_archived = false`. Si dos POST concurrentes insertan el mismo
 * (name, account_number) en una company, el segundo dispara `23505` con
 * este constraint name.
 */
export const IDX_BANKS_NAME_ACCOUNT_UNIQUE = 'idx_banks_company_name_account_unique';

/**
 * Traduce errores de Postgres a `HttpException`s con mensaje legible.
 * No re-lanza: si no matchea, retorna y deja que el caller relance.
 */
export function translateBankConstraintError(error: unknown): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }

  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
  };

  if (
    pgError.code === PG_UNIQUE_VIOLATION &&
    pgError.constraint === IDX_BANKS_NAME_ACCOUNT_UNIQUE
  ) {
    throw new ConflictException({
      message: 'Ya existe una cuenta bancaria con el mismo nombre y número',
      payload: { code: 'BANK_DUPLICATE' },
    });
  }
}
