import type { MailConfig } from '@/config/mail.config';

import { LogDriver } from './log.driver';
import type { MailDriver } from './mail-driver.interface';
import { ResendDriver } from './resend.driver';
import { SmtpDriver } from './smtp.driver';

/**
 * ÚNICO lugar donde se decide el proveedor.
 *
 * ── Cómo cambiar de proveedor (p. ej. Resend → SendGrid) ────────────────────
 *   1. Crear `drivers/sendgrid.driver.ts` implementando `MailDriver`
 *      (usa `resend.driver.ts` como molde: son ~120 líneas).
 *   2. Añadir `'sendgrid'` a `MailDriverName` y su bloque de credenciales en
 *      `src/config/mail.config.ts` (+ `.env.example` y `validation.schema.ts`).
 *   3. Añadir un `case 'sendgrid'` aquí.
 * Listo. Ni `MailService`, ni las plantillas, ni los controladores, ni ningún
 * módulo que envíe correos se entera del cambio.
 */
export const createMailDriver = (config: MailConfig): MailDriver => {
  switch (config.driver) {
    case 'resend':
      return new ResendDriver(config);
    case 'smtp':
      return new SmtpDriver(config);
    case 'log':
      return new LogDriver(config);
    default: {
      // Exhaustividad comprobada en compilación: si se añade un driver a
      // `MailDriverName` y se olvida el `case`, TypeScript rompe el build aquí.
      const exhaustive: never = config.driver;
      throw new Error(`Driver de correo desconocido: ${String(exhaustive)}`);
    }
  }
};
