import { Injectable, Logger } from '@nestjs/common';

import { maskEmail } from '../internal/mail-address';
import { MailService } from '../mail.service';
import { renderAccountActivatedEmail } from '../templates/template-catalog';

export interface AccountActivatedEmailInput {
  customer_name: string;
  customer_email: string;
  /** Puede venir vacío: la plantilla se adapta. */
  company_name: string;
}

/**
 * Avisa al dueño de que su cuenta quedó activa.
 *
 * NUNCA LANZA, igual que la bienvenida: se dispara dentro de la activación, y
 * un proveedor caído no puede hacer que una cuenta ya activada parezca fallida.
 * El fallo queda en el log y en el contador de `/admin/mail/status`.
 */
@Injectable()
export class SendAccountActivatedEmailAction {
  private readonly logger = new Logger(SendAccountActivatedEmailAction.name);

  constructor(private readonly mailService: MailService) {}

  async execute(input: AccountActivatedEmailInput): Promise<boolean> {
    if (!this.mailService.isEnabled()) {
      this.logger.warn('Sin proveedor de correo: no se envió el aviso de activación.');
      return false;
    }

    try {
      const email = await renderAccountActivatedEmail({
        customer_name: input.customer_name,
        company_name: input.company_name,
      });
      await this.mailService.send({
        to: input.customer_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      this.logger.log(`Aviso de activación enviado a ${maskEmail(input.customer_email)}.`);
      return true;
    } catch (e) {
      this.logger.error(
        `No se pudo avisar de la activación a ${maskEmail(input.customer_email)}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return false;
    }
  }
}
