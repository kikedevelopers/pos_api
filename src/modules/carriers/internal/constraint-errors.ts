import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';

export const IDX_CARRIER_NAME_UNIQUE = 'idx_carriers_company_name_unique';

/**
 * Traduce colisiones UNIQUE de `carriers` a `409 Conflict` con `code`
 * específico.
 */
export function translateCarrierConstraintError(error: unknown): void {
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

  if (constraint === IDX_CARRIER_NAME_UNIQUE) {
    throw new ConflictException({
      message: 'Ya existe un transportista con este nombre.',
      payload: { code: 'CARRIER_NAME_TAKEN' },
    });
  }

  throw new ConflictException({
    message: 'Ya existe un transportista con estos datos.',
    payload: { code: 'CARRIER_DUPLICATE' },
  });
}
