import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation`.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Nombre del UNIQUE index parcial `(company_id) WHERE status = 'open'`.
 * Garantiza UN turno abierto por company. Una apertura concurrente o
 * sobre estado ya abierto dispara `unique_violation` con este constraint
 * name → 409 con `code: CASH_REGISTER_ALREADY_OPEN`.
 */
export const IDX_CASH_REGISTERS_ONE_OPEN_PER_COMPANY = 'idx_cash_registers_one_open_per_company';

export function translateCashRegisterConstraintError(error: unknown): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }

  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
  };

  if (
    pgError.code === PG_UNIQUE_VIOLATION &&
    pgError.constraint === IDX_CASH_REGISTERS_ONE_OPEN_PER_COMPANY
  ) {
    throw new ConflictException({
      message: 'Ya existe una caja abierta para esta empresa',
      payload: { code: 'CASH_REGISTER_ALREADY_OPEN' },
    });
  }
}
