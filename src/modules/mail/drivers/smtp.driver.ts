import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import type { MailConfig } from '@/config/mail.config';

import { describeSmtpFailure, isRetriableSmtpFailure } from '../internal/mail-errors';

import {
  MailDeliveryError,
  type MailDriver,
  type MailDriverHealth,
  type MailMessage,
  type MailSendResult,
} from './mail-driver.interface';

/**
 * Driver SMTP genérico — el de DESARROLLO (Mailtrap), y también la salida de
 * emergencia si algún día hay que enviar por un SMTP propio o por el de un
 * hosting. No sabe nada de Mailtrap en particular: son host + puerto + usuario.
 *
 * Mailtrap sandbox atrapa TODOS los correos y no entrega ninguno de verdad, que
 * es justo lo que se quiere mientras se desarrolla.
 */
export class SmtpDriver implements MailDriver {
  readonly name = 'smtp';
  private readonly logger = new Logger(SmtpDriver.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: MailConfig) {}

  isConfigured(): boolean {
    return this.config.smtp.host.length > 0;
  }

  /** Transporte perezoso y reutilizado: abrir uno por envío es caro. */
  private getTransporter(): Transporter {
    if (this.transporter) {
      return this.transporter;
    }
    const { host, port, username, password, secure } = this.config.smtp;
    this.transporter = createTransport({
      host,
      port,
      secure,
      auth: username ? { user: username, pass: password } : undefined,
      connectionTimeout: this.config.timeoutMs,
      greetingTimeout: this.config.timeoutMs,
      socketTimeout: this.config.timeoutMs,
    });
    return this.transporter;
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const started = Date.now();
    const replyTo = message.replyTo ?? this.config.replyTo;

    try {
      // `sendMail` está tipado como `any` en nodemailer: lo acotamos aquí para
      // que el `any` no se propague al resto del módulo.
      const info = (await this.getTransporter().sendMail({
        from: message.from ?? this.config.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        replyTo: replyTo || undefined,
        cc: message.cc?.length ? message.cc : undefined,
        bcc: message.bcc?.length ? message.bcc : undefined,
      })) as { messageId?: unknown };

      return {
        messageId: typeof info.messageId === 'string' ? info.messageId : null,
        provider: this.name,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.logger.warn(`SMTP rechazó el envío: ${detail}`);
      throw new MailDeliveryError(
        describeSmtpFailure(e),
        this.name,
        isRetriableSmtpFailure(e),
        detail,
      );
    }
  }

  async verify(): Promise<MailDriverHealth> {
    if (!this.isConfigured()) {
      return { healthy: false, detail: 'Falta SMTP_HOST en el servidor.', latencyMs: null };
    }

    const started = Date.now();
    try {
      // `verify()` abre la conexión y hace el handshake + login SIN enviar
      // nada: es el diagnóstico más fiable que da SMTP.
      await this.getTransporter().verify();
      return {
        healthy: true,
        detail: `Conectado a ${this.config.smtp.host}:${this.config.smtp.port}.`,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      return {
        healthy: false,
        detail: describeSmtpFailure(e),
        latencyMs: Date.now() - started,
      };
    }
  }
}
