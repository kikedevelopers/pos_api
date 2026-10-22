import { UnprocessableEntityException } from '@nestjs/common';

import { APP_TIMEZONE, dayjs, nowBogota } from '@/common/utils/dayjs';

/** Formato estricto del día de vencimiento que envía el cliente. */
export const PAYMENT_DUE_DATE_FORMAT = 'YYYY-MM-DD';

/**
 * Convierte el día de vencimiento elegido por el usuario (`YYYY-MM-DD`, día
 * calendario COLOMBIANO) en el instante exacto en que vence el plazo de pago
 * de la compra: el FINAL de ese día en Bogotá (23:59:59.999).
 *
 * Reglas:
 *   - `null`/`undefined` → la compra no tiene plazo de pago (devuelve `null`).
 *   - El día debe ser una fecha real (no `2026-02-30`).
 *   - El día no puede ser anterior a HOY en Bogotá (hoy sí es válido: vence a
 *     las 23:59:59 de hoy).
 *
 * `now` es inyectable para que los tests no dependan del reloj.
 */
export function resolvePaymentDueAt(
  paymentDueDate: string | null | undefined,
  now: dayjs.Dayjs = nowBogota(),
): Date | null {
  if (paymentDueDate === null || paymentDueDate === undefined) {
    return null;
  }

  const raw = paymentDueDate.trim();
  const parsed = dayjs(raw, PAYMENT_DUE_DATE_FORMAT, true);
  if (!parsed.isValid()) {
    throw new UnprocessableEntityException('El plazo de pago no es una fecha válida');
  }

  const dueEndOfDay = dayjs.tz(raw, APP_TIMEZONE).endOf('day');
  const today = now.tz(APP_TIMEZONE).format(PAYMENT_DUE_DATE_FORMAT);
  if (raw < today) {
    throw new UnprocessableEntityException(
      'El plazo de pago no puede ser una fecha anterior a hoy',
    );
  }

  return dueEndOfDay.toDate();
}
