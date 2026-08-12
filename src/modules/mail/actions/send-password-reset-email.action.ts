import { Injectable, Logger } from '@nestjs/common';

import { maskEmail } from '../internal/mail-address';
import { MailService } from '../mail.service';
import { renderPasswordResetEmail } from '../templates/template-catalog';

export interface PasswordResetEmailInput {
  customer_name: string;
  customer_email: string;
  /** Enlace de un solo uso que abre PlacePos. */
  reset_url: string;
}

/**
 * Envía el enlace para cambiar la contraseña.
 *
 * NUNCA lanza: devuelve `false` si el correo no salió. Quien llama decide qué
 * hacer con eso — y en este flujo sí importa, porque decirle "revisa tu correo"
 * a alguien cuyo correo nunca salió lo deja esperando para siempre.
 */
@Injectable()
export class SendPasswordResetEmailAction {
  private readonly logger = new Logger(SendPasswordResetEmailAction.name);

  constructor(private readonly mailService: MailService) {}

  async execute(input: PasswordResetEmailInput): Promise<boolean> {
    if (!this.mailService.isEnabled()) {
      this.logger.warn('Sin proveedor de correo: no se envió el enlace de recuperación.');
      return false;
    }

    try {
      const email = await renderPasswordResetEmail({
        customer_name: input.customer_name,
        reset_url: input.reset_url,
      });
      await this.mailService.send({
        to: input.customer_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      this.logger.log(`Enlace de recuperación enviado a ${maskEmail(input.customer_email)}.`);
      return true;
    } catch (e) {
      this.logger.error(
        `No se pudo enviar la recuperación a ${maskEmail(input.customer_email)}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return false;
    }
  }
}
