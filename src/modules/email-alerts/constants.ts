/**
 * Tipos de alerta POR CORREO (distintos de las alertas in-app de `app-alerts`).
 * El flag on/off de cada una se persiste en `alert_configs` (reusando esa tabla)
 * con este `type`.
 */
export const ALERT_TYPE_CREDIT_DUE_TODAY = 'CREDIT_DUE_TODAY';

export const EMAIL_ALERT_TYPES = [ALERT_TYPE_CREDIT_DUE_TODAY] as const;

export type EmailAlertType = (typeof EMAIL_ALERT_TYPES)[number];

export const isEmailAlertType = (value: string): value is EmailAlertType =>
  (EMAIL_ALERT_TYPES as readonly string[]).includes(value);
