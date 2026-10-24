import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/** Postgres SQLSTATE para `unique_violation`. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Traduce la colisión de nombre de plan per-company (`idx_loan_plans_company_
 * name_unique`) a 409 con un `code` branchable. Si no es UNIQUE, no re-lanza:
 * el error original sube.
 */
export function translateLoanPlanConstraintError(error: unknown): void {
  if (!(error instanceof QueryFailedError)) return;
  const pgError = error as QueryFailedError & { code?: string };
  if (pgError.code !== PG_UNIQUE_VIOLATION) return;
  throw new ConflictException({
    message: 'Ya existe un plan de préstamo con este nombre.',
    payload: { code: 'LOAN_PLAN_NAME_TAKEN' },
  });
}
