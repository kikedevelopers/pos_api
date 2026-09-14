import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { dayjs, APP_TIMEZONE } from '@/common/utils/dayjs';

import { MailDeliveryError } from '../drivers/mail-driver.interface';
import { maskEmail } from '../internal/mail-address';
import { MailService } from '../mail.service';
import { renderSampleEmail, type EmailTemplateId } from '../templates/template-catalog';
import { renderTestEmail, type RenderedEmail } from '../templates/test-email.template';

export interface SendTestEmailResult {
  ok: boolean;
  /** Destinatario enmascarado: el panel no necesita el correo completo de vuelta. */
  to: string;
  provider: string;
  messageId: string | null;
  durationMs: number | null;
  /** Plantilla enviada, o `null` si fue el correo de diagnóstico simple. */
  template: EmailTemplateId | null;
  /** Mensaje ya en español, listo para el toast del panel. */
  message: string;
}

/**
 * Envía un correo de prueba desde el panel kdevs-admin. Dos modos:
 *
 *   - sin `template` → correo de DIAGNÓSTICO: responde "¿sale un correo de
 *     aquí?" y lleva dentro el proveedor y el entorno;
 *   - con `template` → la plantilla REAL con datos de muestra, renderizada por
 *     el mismo código que usa producción. Sirve para revisar el diseño en un
 *     cliente de correo de verdad, que es donde se rompe lo que se ve bien en
 *     el navegador.
 *
 * Devuelve `ok: false` con el motivo en vez de lanzar cuando el proveedor
 * rechaza el envío: un fallo de correo NO es un error del panel, es justo el
 * diagnóstico que se estaba pidiendo, y llega mejor como resultado que como 500.
 */
@Injectable()
export class SendTestEmailAction {
  private readonly logger = new Logger(SendTestEmailAction.name);

  constructor(private readonly mailService: MailService) {}

  async execute(to: string, template?: EmailTemplateId): Promise<SendTestEmailResult> {
    if (!this.mailService.isEnabled()) {
      throw new ServiceUnavailableException(
        'El servidor no tiene configurado un proveedor de correo.',
      );
    }

    const email: RenderedEmail = template
      ? await renderSampleEmail(template)
      : renderTestEmail({
          provider: this.mailService.providerName,
          environment: process.env.NODE_ENV ?? 'development',
          from: this.mailService.defaultFrom,
          sentAtLabel: dayjs().tz(APP_TIMEZONE).format('DD/MM/YYYY hh:mm A'),
        });

    try {
      const result = await this.mailService.send({
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });

      return {
        ok: true,
        to: maskEmail(to),
        provider: result.provider,
        messageId: result.messageId,
        durationMs: result.durationMs,
        template: template ?? null,
        message:
          result.provider === 'log'
            ? 'El servidor está en modo local: el correo quedó en el log, no se envió.'
            : 'Correo de prueba enviado. Revisa la bandeja de entrada (y la carpeta de spam).',
      };
    } catch (e) {
      if (e instanceof MailDeliveryError) {
        this.logger.warn(`Prueba de envío fallida (${e.provider}): ${e.detail ?? e.message}`);
        return {
          ok: false,
          to: maskEmail(to),
          provider: e.provider,
          messageId: null,
          durationMs: null,
          template: template ?? null,
          message: e.message,
        };
      }
      throw e;
    }
  }
}
