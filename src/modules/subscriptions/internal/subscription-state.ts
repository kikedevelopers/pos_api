import { SubscriptionPlan, SubscriptionStatus } from '../entities/subscription.entity';

/**
 * Estado que se le MUESTRA al dueño, ya cruzado con la vigencia.
 *
 * `expires_at` dice hasta cuándo puede usar la app; `status` dice por qué está
 * como está. Quien pinta la pantalla necesita las dos cosas resueltas en un
 * solo valor, y ese cruce tiene que vivir en un sitio puro y testeado: si cada
 * cliente lo reimplementa, tarde o temprano uno le dice "vencida" a quien en
 * realidad tiene un pago rebotado, y el dueño llama a soporte en vez de
 * reintentar el cobro.
 *
 * `expired` es el único valor que no existe en la columna: se deriva.
 */
export type EffectiveSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'payment_pending'
  | 'payment_failed'
  | 'canceled'
  | 'expired';

export interface SubscriptionStateInput {
  status: SubscriptionStatus;
  expires_at: Date;
  now?: Date;
}

/** `true` cuando la ventana de vigencia ya pasó (la app queda bloqueada). */
export const isSubscriptionExpired = (expiresAt: Date, now: Date = new Date()): boolean =>
  expiresAt.getTime() <= now.getTime();

/**
 * Cruza estado de cobro y vigencia.
 *
 * Vigente → manda el estado almacenado tal cual (una suscripción todavía viva
 * con el cobro rebotado debe decir "revisa tu pago", no "activa").
 *
 * Vencida → los estados de cobro sobreviven porque explican el vencimiento;
 * `trialing`/`active` colapsan a `expired`, que es lo que le pasó.
 */
export function resolveEffectiveStatus({
  status,
  expires_at,
  now = new Date(),
}: SubscriptionStateInput): EffectiveSubscriptionStatus {
  if (!isSubscriptionExpired(expires_at, now)) {
    return status;
  }

  switch (status) {
    case SubscriptionStatus.PAYMENT_FAILED:
      return 'payment_failed';
    case SubscriptionStatus.PAYMENT_PENDING:
      return 'payment_pending';
    case SubscriptionStatus.CANCELED:
      return 'canceled';
    default:
      return 'expired';
  }
}

/** Planes que se cobran. `free` es la prueba, no se cobra. */
export const isPaidPlan = (plan: SubscriptionPlan): boolean => plan !== SubscriptionPlan.FREE;
