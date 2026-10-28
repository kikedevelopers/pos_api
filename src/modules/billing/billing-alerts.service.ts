import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { BillingConfig } from '@/config/billing.config';
import { MailService } from '@/modules/mail/mail.service';

export interface BillingAlert {
  /** Una línea: qué pasó. */
  title: string;
  /** Pares rótulo → valor para el cuerpo (pago, empresa, transacción…). */
  details: Record<string, string | number | null | undefined>;
}

/**
 * Aviso INMEDIATO al operador cuando algo del cobro sale mal con dinero de por
 * medio: un pago aprobado que no se pudo aplicar, que no cuadra, o un webhook
 * con firma falsa.
 *
 * Siempre deja un `logger.error` (aunque no haya correo configurado) y NUNCA
 * lanza: un fallo del correo no puede tumbar el procesamiento del pago.
 */
@Injectable()
export class BillingAlertsService {
  private readonly logger = new Logger(BillingAlertsService.name);

  constructor(
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  async notify(alert: BillingAlert): Promise<void> {
    const lines = Object.entries(alert.details).map(
      ([label, value]) => `${label}: ${value ?? '—'}`,
    );
    this.logger.error({ event: 'billing.alert', title: alert.title, ...alert.details });

    const recipients = this.configService.getOrThrow<BillingConfig>('billing').alertEmails;
    if (recipients.length === 0 || !this.mailService.isEnabled()) {
      this.logger.warn('Alerta de cobro sin destinatarios de correo (BILLING_ALERT_EMAILS).');
      return;
    }

    const escape = (text: string): string =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    try {
      await this.mailService.send({
        to: recipients,
        subject: `[PlacePOS · Cobros] ${alert.title}`,
        text: `${alert.title}\n\n${lines.join('\n')}`,
        html: `<h2 style="font-family:sans-serif">${escape(alert.title)}</h2><ul style="font-family:monospace">${lines
          .map((line) => `<li>${escape(line)}</li>`)
          .join('')}</ul>`,
      });
    } catch (e) {
      this.logger.error(
        `No se pudo enviar la alerta de cobro por correo: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
