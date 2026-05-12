import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation`.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Constraint names. Cada uno mapea a un caso de error legible.
 */
export const IDX_PURCHASES_NUMBER_UNIQUE = 'idx_purchases_company_number_unique';
export const IDX_PURCHASE_PAYMENTS_NUMBER_UNIQUE = 'idx_purchase_payments_company_number_unique';
export const IDX_PURCHASE_PAYMENTS_UUID_UNIQUE = 'idx_purchase_payments_company_uuid_unique';
export const IDX_PURCHASE_CREDITS_PURCHASE_UNIQUE = 'idx_purchase_credits_company_purchase_unique';

/**
 * Traduce errores de unique_violation en `purchases`/`purchase_payments`
 * /`purchase_credits` a `ConflictException` con códigos legibles.
 *
 * El uuid duplicado se maneja en el flujo de pago ANTES del INSERT (fast-path
 * de idempotencia que devuelve 200). Este traductor cubre la race-condition
 * donde dos requests con el mismo uuid llegan en simultáneo y solo uno gana
 * la inserción: el perdedor recibe `23505` con el constraint del uuid, que
 * tratamos como señal de "ya procesado" — el action lo captura por separado.
 */
export function translatePurchaseConstraintError(error: unknown): void {
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

  if (pgError.constraint === IDX_PURCHASES_NUMBER_UNIQUE) {
    throw new ConflictException({
      message: 'Folio de compra duplicado. Reintenta la operación.',
      payload: { code: 'PURCHASE_NUMBER_DUPLICATE' },
    });
  }
  if (pgError.constraint === IDX_PURCHASE_PAYMENTS_NUMBER_UNIQUE) {
    throw new ConflictException({
      message: 'Folio de abono duplicado. Reintenta la operación.',
      payload: { code: 'PURCHASE_PAYMENT_NUMBER_DUPLICATE' },
    });
  }
  if (pgError.constraint === IDX_PURCHASE_CREDITS_PURCHASE_UNIQUE) {
    throw new ConflictException({
      message: 'Ya existe un crédito asociado a esta compra',
      payload: { code: 'PURCHASE_CREDIT_DUPLICATE' },
    });
  }
}

/**
 * Detecta si el error que volcó la transacción fue una colisión por uuid
 * idempotente. El action lo trata como señal para releer el pago ya
 * persistido (la otra request ganó) y devolverlo con 200.
 */
export function isPurchasePaymentUuidConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
  };
  return (
    pgError.code === PG_UNIQUE_VIOLATION && pgError.constraint === IDX_PURCHASE_PAYMENTS_UUID_UNIQUE
  );
}
