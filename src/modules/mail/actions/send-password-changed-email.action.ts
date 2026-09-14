import { Injectable, Logger } from '@nestjs/common';

import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';

import { maskEmail } from '../internal/mail-address';
import { MailService } from '../mail.service';
import { renderPasswordChangedEmail } from '../templates/template-catalog';

export interface PasswordChangedEmailInput {
  customer_email: string;
}

/**
 * Avisa de que la contraseña cambió.
 *
 * NUNCA LANZA: la contraseña ya está cambiada cuando esto corre, y un proveedor
 * caído no puede convertir un cambio exitoso en un error para el usuario.
 *
 * Aun así el correo importa: es la única señal que recibe alguien a quien le
 * robaron el acceso. Por eso el fallo se registra como ERROR, no como aviso.
 */
@Injectable()
export class SendPasswordChangedEmailAction {
  private readonly logger = new Logger(SendPasswordChangedEmailAction.name);

  constructor(private readonly mailService: MailService) {}

  async execute(input: PasswordChangedEmailInput): Promise<boolean> {
    if (!this.mailService.isEnabled()) {
      this.logger.warn('Sin proveedor de correo: no se avisó del cambio de contraseña.');
      return false;
    }

    try {
      const email = await renderPasswordChangedEmail({
        changed_at_label: dayjs().tz(APP_TIMEZONE).format('DD/MM/YYYY [a las] hh:mm A'),
      });
      await this.mailService.send({
        to: input.customer_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      this.logger.log(
        `Aviso de cambio de contraseña enviado a ${maskEmail(input.customer_email)}.`,
      );
      return true;
    } catch (e) {
      this.logger.error(
        `No se pudo avisar del cambio de contraseña a ${maskEmail(input.customer_email)}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return false;
    }
  }
}
