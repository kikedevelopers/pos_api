import { registerAs } from '@nestjs/config';

/**
 * Proveedores de correo soportados. Añadir uno nuevo (SendGrid, Postmark, SES…)
 * es agregar su valor aquí + un archivo en `modules/mail/drivers/` + una rama en
 * `createMailDriver`. Nada más del código toca al proveedor.
 */
export type MailDriverName = 'resend' | 'smtp' | 'log';

/** Credenciales de Resend (producción). */
export interface ResendConfig {
  apiKey: string;
  baseUrl: string;
}

/** Credenciales SMTP genéricas (Mailtrap en desarrollo, o cualquier SMTP). */
export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  /** `true` = TLS implícito (puerto 465). En 587/2525 se usa STARTTLS. */
  secure: boolean;
}

/**
 * Configuración del módulo de correo.
 *
 * `driver` es el ÚNICO interruptor que decide por dónde salen los correos.
 * Vacío = se resuelve solo: `resend` si hay API key, `smtp` si hay host, y
 * `log` como último recurso (escribe el correo en el log en vez de enviarlo,
 * para que desarrollar sin credenciales no reviente).
 */
export interface MailConfig {
  driver: MailDriverName;
  /** Remitente por defecto: `Nombre <correo@dominio>` o solo el correo. */
  from: string;
  /** Responder-a por defecto. Vacío = no se envía la cabecera. */
  replyTo: string;
  /** Corte duro de cada envío / verificación (ms). */
  timeoutMs: number;
  resend: ResendConfig;
  smtp: SmtpConfig;
}

/**
 * Resuelve el driver cuando `MAIL_DRIVER` viene vacío. Se exporta para poder
 * testear la cascada sin montar el ConfigModule.
 */
export const resolveMailDriver = (
  explicit: string | undefined,
  { hasResendKey, hasSmtpHost }: { hasResendKey: boolean; hasSmtpHost: boolean },
): MailDriverName => {
  const normalized = explicit?.trim().toLowerCase();
  if (normalized === 'resend' || normalized === 'smtp' || normalized === 'log') {
    return normalized;
  }
  if (hasResendKey) {
    return 'resend';
  }
  if (hasSmtpHost) {
    return 'smtp';
  }
  return 'log';
};

export default registerAs<MailConfig>('mail', () => {
  const resendApiKey = process.env.RESEND_API_KEY?.trim() ?? '';
  const smtpHost = process.env.SMTP_HOST?.trim() ?? '';
  const smtpPort = parseInt(process.env.SMTP_PORT ?? '2525', 10);

  return {
    driver: resolveMailDriver(process.env.MAIL_DRIVER, {
      hasResendKey: resendApiKey.length > 0,
      hasSmtpHost: smtpHost.length > 0,
    }),
    from: process.env.MAIL_FROM?.trim() || 'PlacePOS <no-reply@kikedevs.com>',
    replyTo: process.env.MAIL_REPLY_TO?.trim() ?? '',
    timeoutMs: parseInt(process.env.MAIL_TIMEOUT_MS ?? '15000', 10),
    resend: {
      apiKey: resendApiKey,
      baseUrl: (process.env.RESEND_BASE_URL?.trim() || 'https://api.resend.com').replace(
        /\/+$/,
        '',
      ),
    },
    smtp: {
      host: smtpHost,
      port: Number.isFinite(smtpPort) ? smtpPort : 2525,
      username: process.env.SMTP_USERNAME?.trim() ?? '',
      password: process.env.SMTP_PASSWORD ?? '',
      // 465 es TLS implícito por convención; el resto usa STARTTLS.
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : smtpPort === 465,
    },
  };
});
