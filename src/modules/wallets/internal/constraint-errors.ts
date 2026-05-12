import { BadRequestException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation`.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Nombre del UNIQUE index parcial sobre `(company_id, name)` WHERE
 * `is_archived = false`.
 *
 * PlacePos devuelve 400 (no 409) cuando hay billetera duplicada — mantenemos
 * ese contrato. Mensaje literal:
 *   "Ya existe una billetera con el mismo nombre"
 */
export const IDX_WALLETS_NAME_UNIQUE = 'idx_wallets_company_name_unique';

export function translateWalletConstraintError(error: unknown): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }

  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
  };

  if (pgError.code === PG_UNIQUE_VIOLATION && pgError.constraint === IDX_WALLETS_NAME_UNIQUE) {
    throw new BadRequestException('Ya existe una billetera con el mismo nombre');
  }
}
