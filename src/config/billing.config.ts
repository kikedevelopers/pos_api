import { registerAs } from '@nestjs/config';

/**
 * Cobro de la suscripción con Wompi (módulo `billing`).
 *
 *   - `environment`: `sandbox` (pruebas, dinero ficticio) o `production`
 *     (dinero real). Decide la URL base del API de Wompi.
 *   - `privateKey`: llave privada (`prv_test_…` / `prv_prod_…`). Crea los links
 *     de pago y consulta transacciones. Vive SOLO en el servidor.
 *   - `eventsSecret`: secreto de eventos (`test_events_…` / `prod_events_…`).
 *     Verifica la firma de los webhooks.
 *   - `returnUrl`: base pública de la landing; Wompi devuelve al cliente a
 *     `<returnUrl>/panel/pago?ref=…` al terminar.
 *   - `alertEmails`: a quién se avisa al instante si un pago aprobado no se pudo
 *     aplicar o no cuadra. Es dinero real: un fallo silencioso no es opción.
 *
 * Las llaves de un ambiente NO sirven en el otro. Mezclarlas (llave de pruebas
 * contra producción o al revés) se detecta aquí y deja el cobro deshabilitado
 * con un motivo legible, en vez de fallar a mitad de un pago.
 */
export type WompiEnvironment = 'sandbox' | 'production';

export interface BillingConfig {
  environment: WompiEnvironment;
  apiBaseUrl: string;
  privateKey: string;
  eventsSecret: string;
  timeoutMs: number;
  returnUrl: string;
  alertEmails: string[];
  reconcileEnabled: boolean;
  /** `true` = hay llaves válidas para el ambiente: se puede cobrar. */
  configured: boolean;
  /** Por qué no está configurado (vacío si lo está). */
  configurationError: string;
}

export const WOMPI_API_BASE_URLS: Record<WompiEnvironment, string> = {
  sandbox: 'https://sandbox.wompi.co/v1',
  production: 'https://production.wompi.co/v1',
};

const KEY_PREFIXES: Record<WompiEnvironment, { private: string; events: string }> = {
  sandbox: { private: 'prv_test_', events: 'test_events_' },
  production: { private: 'prv_prod_', events: 'prod_events_' },
};

/**
 * Valida que las llaves existan y sean del ambiente elegido. Devuelve el motivo
 * del fallo o `''` si todo cuadra.
 */
export function validateWompiKeys(
  environment: WompiEnvironment,
  privateKey: string,
  eventsSecret: string,
): string {
  const prefixes = KEY_PREFIXES[environment];
  if (!privateKey) {
    return 'Falta WOMPI_PRIVATE_KEY.';
  }
  if (!eventsSecret) {
    return 'Falta WOMPI_EVENTS_SECRET.';
  }
  if (!privateKey.startsWith(prefixes.private)) {
    return `WOMPI_PRIVATE_KEY no es del ambiente ${environment} (debe empezar por ${prefixes.private}).`;
  }
  if (!eventsSecret.startsWith(prefixes.events)) {
    return `WOMPI_EVENTS_SECRET no es del ambiente ${environment} (debe empezar por ${prefixes.events}).`;
  }
  return '';
}

export function resolveBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const environment: WompiEnvironment =
    env.WOMPI_ENVIRONMENT?.trim() === 'production' ? 'production' : 'sandbox';
  const privateKey = env.WOMPI_PRIVATE_KEY?.trim() ?? '';
  const eventsSecret = env.WOMPI_EVENTS_SECRET?.trim() ?? '';
  const configurationError = validateWompiKeys(environment, privateKey, eventsSecret);

  return {
    environment,
    apiBaseUrl: WOMPI_API_BASE_URLS[environment],
    privateKey,
    eventsSecret,
    timeoutMs: parseInt(env.WOMPI_API_TIMEOUT_MS ?? '15000', 10) || 15000,
    returnUrl: (
      env.BILLING_RETURN_URL?.trim() ||
      env.ACTIVATION_BASE_URL?.trim() ||
      'https://placepos.kikedevs.com'
    ).replace(/\/+$/, ''),
    alertEmails: (env.BILLING_ALERT_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim())
      .filter((email) => email.length > 0),
    reconcileEnabled: env.BILLING_RECONCILE_ENABLED !== 'false',
    configured: configurationError === '',
    configurationError,
  };
}

export default registerAs<BillingConfig>('billing', () => resolveBillingConfig());
