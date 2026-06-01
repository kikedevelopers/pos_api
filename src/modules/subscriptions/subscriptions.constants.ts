/**
 * Días de trial (gracia) que se otorgan al crear la suscripción de una company.
 *
 * `expires_at = started_at + SUBSCRIPTION_TRIAL_DAYS días`. No hay renovación
 * implementada todavía: cuando vence, la company queda bloqueada.
 */
export const SUBSCRIPTION_TRIAL_DAYS = 10;

/**
 * Días de trial cuando la cuenta cloud se crea DESDE un POS offline
 * (`placepos`) en su PRIMERA migración a "modo cloud".
 *
 * Es deliberadamente más corto que `SUBSCRIPTION_TRIAL_DAYS`: la migración
 * desde offline crea la cuenta y sube el backup en el mismo flujo, así que el
 * negocio ya está "vivo" y solo necesita una ventana mínima para activar el
 * pago. Auto-protegido: nadie pediría MENOS días para abusar, por eso el flag
 * que dispara este valor puede ser público sin gating extra.
 */
export const SUBSCRIPTION_MIGRATION_DAYS = 1;

/**
 * Calcula `expires_at` a partir de `started_at` sumando `days` días.
 *
 * El repo no usa `date-fns`; sumamos milisegundos. 1 día = 86_400_000 ms.
 * Coherente con timestamptz (UTC) — no hay ambigüedad de zona horaria porque
 * operamos sobre el epoch absoluto del `Date`.
 */
export function addDays(from: Date, days: number): Date {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return new Date(from.getTime() + days * MS_PER_DAY);
}
