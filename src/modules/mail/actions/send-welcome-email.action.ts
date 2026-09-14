import { Injectable, Logger } from '@nestjs/common';

import { maskEmail } from '../internal/mail-address';
import { MailService } from '../mail.service';
import { renderWelcomeEmail } from '../templates/template-catalog';

export interface WelcomeEmailInput {
  customer_name: string;
  customer_email: string;
  company_name: string;
  /** Enlace de activación con el token de un solo uso. */
  activation_url: string;
}

/**
 * Manda el correo de bienvenida a un dueño recién registrado.
 *
 * NUNCA LANZA. Es deliberado: este correo se dispara dentro del registro, y un
 * proveedor caído o una llave vencida no pueden impedir que alguien cree su
 * cuenta. El fallo queda en el log y en el contador de `/admin/mail/status`,
 * que es donde toca mirarlo — no en la cara del cliente que se está registrando.
 */
@Injectable()
export class SendWelcomeEmailAction {
  private readonly logger = new Logger(SendWelcomeEmailAction.name);

  constructor(private readonly mailService: MailService) {}

  async execute(input: WelcomeEmailInput): Promise<boolean> {
    if (!this.mailService.isEnabled()) {
      this.logger.warn('Sin proveedor de correo: no se envió la bienvenida.');
      return false;
    }

    try {
      const email = await renderWelcomeEmail(input);
      await this.mailService.send({
        to: input.customer_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      this.logger.log(`Bienvenida enviada a ${maskEmail(input.customer_email)}.`);
      return true;
    } catch (e) {
      this.logger.error(
        `No se pudo enviar la bienvenida a ${maskEmail(input.customer_email)}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return false;
    }
  }
}
