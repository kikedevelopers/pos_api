import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation`.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Constraint names.
 */
export const IDX_SALE_INVOICES_TICKET_NUMBER_UNIQUE =
  'idx_sale_invoices_company_ticket_number_unique';
export const IDX_SALE_INVOICES_SALE_NUMBER_UNIQUE = 'idx_sale_invoices_company_sale_number_unique';
export const IDX_SALE_PAYMENTS_UUID_UNIQUE = 'idx_sale_payments_company_uuid_unique';
export const IDX_SALE_CREDITS_SALE_UNIQUE = 'idx_sale_credits_company_sale_unique';

/**
 * Traduce errores de `unique_violation` en `sale_invoices` / `sale_payments`
 * / `sale_credits` a `ConflictException` con códigos legibles.
 *
 * El uuid duplicado en `sale_payments` se maneja en el flujo de pago ANTES
 * del INSERT (fast-path de idempotencia que devuelve 200). Si la carrera
 * logra burlar el fast-path, el detector `isSalePaymentUuidConflict` captura
 * la colisión y el caller relee el row ganador.
 */
export function translateSaleConstraintError(error: unknown): void {
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

  if (pgError.constraint === IDX_SALE_INVOICES_TICKET_NUMBER_UNIQUE) {
    throw new ConflictException({
      message: 'Folio de venta duplicado. Reintenta la operación.',
      payload: { code: 'SALE_TICKET_NUMBER_DUPLICATE' },
    });
  }
  if (pgError.constraint === IDX_SALE_INVOICES_SALE_NUMBER_UNIQUE) {
    throw new ConflictException({
      message: 'Folio SALE duplicado. Reintenta la operación.',
      payload: { code: 'SALE_NUMBER_DUPLICATE' },
    });
  }
  if (pgError.constraint === IDX_SALE_CREDITS_SALE_UNIQUE) {
    throw new ConflictException({
      message: 'Ya existe un crédito asociado a esta venta',
      payload: { code: 'SALE_CREDIT_DUPLICATE' },
    });
  }
}

/**
 * Detecta colisión por uuid idempotente. El action lo trata como señal
 * para releer el pago persistido por la otra request y devolverlo con 200.
 */
export function isSalePaymentUuidConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
  };
  return (
    pgError.code === PG_UNIQUE_VIOLATION && pgError.constraint === IDX_SALE_PAYMENTS_UUID_UNIQUE
  );
}
