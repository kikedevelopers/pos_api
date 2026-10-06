import { registerAs } from '@nestjs/config';

/**
 * Configuración del módulo de alertas por correo (`email-alerts`).
 *
 *   - `apiPublicUrl`: base pública del API. El correo de alerta lleva un enlace
 *     DIRECTO a una ruta del API que genera el PDF on-demand, así que debe ser
 *     alcanzable desde fuera (en dev, el túnel ngrok; en prod, el dominio del API).
 *   - `pdfTokenSecret`: secreto para firmar/verificar el token autocontenido del
 *     enlace de descarga (lleva company + fecha + tipo). Sin él, cualquiera
 *     podría forjar el enlace.
 *   - `cronEnabled`: el `@Cron` diario arranca APAGADO; se enciende por env una
 *     vez validado el envío con el botón de prueba.
 */
export interface EmailAlertsConfig {
  apiPublicUrl: string;
  pdfTokenSecret: string;
  pdfTokenExpiresIn: string;
  cronEnabled: boolean;
  cronExpression: string;
}

export default registerAs<EmailAlertsConfig>('emailAlerts', () => ({
  apiPublicUrl: (process.env.API_PUBLIC_URL?.trim() || 'http://localhost:3010').replace(
    /\/+$/,
    '',
  ),
  pdfTokenSecret:
    process.env.ALERT_PDF_TOKEN_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    'dev-alert-pdf-secret-change-me',
  pdfTokenExpiresIn: process.env.ALERT_PDF_TOKEN_EXPIRES_IN?.trim() || '7d',
  cronEnabled: process.env.EMAIL_ALERTS_CRON_ENABLED === 'true',
  // Default: 7:00 a. m. hora Colombia (el scheduler fija timeZone).
  cronExpression: process.env.EMAIL_ALERTS_CRON?.trim() || '0 7 * * *',
}));
