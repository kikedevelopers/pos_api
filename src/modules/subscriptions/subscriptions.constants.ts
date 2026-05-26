/**
 * Días de trial (gracia) que se otorgan al crear la suscripción de una company.
 *
 * `expires_at = started_at + SUBSCRIPTION_TRIAL_DAYS días`. No hay renovación
 * implementada todavía: cuando vence, la company queda bloqueada.
 */
export const SUBSCRIPTION_TRIAL_DAYS = 10;

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
