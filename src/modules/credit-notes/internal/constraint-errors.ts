import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation`.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Constraint / index names.
 */
export const IDX_CREDIT_NOTES_NOTE_NUMBER_UNIQUE = 'idx_credit_notes_company_note_number_unique';
export const IDX_CREDIT_NOTES_ONE_FULL_VOID_PER_SALE = 'idx_credit_notes_one_full_void_per_sale';
export const IDX_CORRECTION_SOURCES_CREDIT_NOTE_UNIQUE =
  'idx_correction_sources_company_credit_note_unique';

/**
 * Traduce errores de `unique_violation` en `credit_notes` y
 * `correction_sources` a `ConflictException` con códigos legibles. El
 * service valida la unicidad antes del INSERT, pero estos detectores
 * actúan como red de seguridad en caso de race condition.
 */
export function translateCreditNoteConstraintError(error: unknown): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }
  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
  };
  if (pgError.code !== PG_UNIQUE_VIOLATION) {
    return;
  }

  if (pgError.constraint === IDX_CREDIT_NOTES_NOTE_NUMBER_UNIQUE) {
    throw new ConflictException({
      message: 'Folio de nota duplicado. Reintenta la operación.',
      payload: { code: 'CREDIT_NOTE_NUMBER_DUPLICATE' },
    });
  }
  if (pgError.constraint === IDX_CREDIT_NOTES_ONE_FULL_VOID_PER_SALE) {
    throw new ConflictException({
      message: 'Ya existe una anulación total activa para esta venta.',
      payload: { code: 'SALE_ALREADY_FULL_VOIDED' },
    });
  }
  if (pgError.constraint === IDX_CORRECTION_SOURCES_CREDIT_NOTE_UNIQUE) {
    throw new ConflictException({
      message: 'La nota ya tiene una fuente de corrección registrada.',
      payload: { code: 'CORRECTION_SOURCE_DUPLICATE' },
    });
  }
}
