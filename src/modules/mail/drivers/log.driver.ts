import { Logger } from '@nestjs/common';

import type { MailConfig } from '@/config/mail.config';

import { maskEmail } from '../internal/mail-address';

import type {
  MailDriver,
  MailDriverHealth,
  MailMessage,
  MailSendResult,
} from './mail-driver.interface';

/**
 * Driver de último recurso: NO envía nada, escribe el correo en el log.
 *
 * Es el que corre cuando no hay credenciales (un clon recién bajado, un test,
 * un entorno de CI). Sin él, cualquier flujo que mande un correo —recuperar
 * contraseña, avisar de un vencimiento— reventaría en desarrollo. Con él,
 * el flujo sigue y el correo queda visible en la consola.
 *
 * Se reporta `healthy` a propósito, pero el estado del panel lo distingue por
 * el nombre del driver: "modo local (no se envía nada)".
 */
export class LogDriver implements MailDriver {
  readonly name = 'log';
  private readonly logger = new Logger(LogDriver.name);

  constructor(private readonly config: MailConfig) {}

  isConfigured(): boolean {
    return true;
  }

  send(message: MailMessage): Promise<MailSendResult> {
    const started = Date.now();
    const to = message.to.map(maskEmail).join(', ');
    this.logger.log(
      `[correo NO enviado — driver 'log'] de "${message.from ?? this.config.from}" para "${to}" · asunto: "${message.subject}"`,
    );
    this.logger.debug(message.text);
    return Promise.resolve({
      messageId: null,
      provider: this.name,
      durationMs: Date.now() - started,
    });
  }

  verify(): Promise<MailDriverHealth> {
    return Promise.resolve({
      healthy: true,
      detail: 'Modo local: los correos se escriben en el log, no se envían.',
      latencyMs: 0,
    });
  }
}
