import { Logger } from '@nestjs/common';

import type { MailConfig } from '@/config/mail.config';

import {
  describeMailHttpFailure,
  describeMailTransportFailure,
  extractMailErrorDetail,
  isRetriableMailFailure,
} from '../internal/mail-errors';

import {
  MailDeliveryError,
  type MailDriver,
  type MailDriverHealth,
  type MailMessage,
  type MailSendResult,
} from './mail-driver.interface';

/**
 * Driver de Resend (https://resend.com) — el proveedor de PRODUCCIÓN.
 *
 * Habla con la API por `fetch` directo, sin SDK: son dos endpoints y así el
 * driver no arrastra una dependencia que actualizar. Misma decisión que el
 * cliente de Gemini.
 */
export class ResendDriver implements MailDriver {
  readonly name = 'resend';
  private readonly logger = new Logger(ResendDriver.name);

  constructor(private readonly config: MailConfig) {}

  isConfigured(): boolean {
    return this.config.resend.apiKey.length > 0;
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      from: message.from ?? this.config.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
    const replyTo = message.replyTo ?? this.config.replyTo;
    if (replyTo) {
      body.reply_to = replyTo;
    }
    if (message.cc?.length) {
      body.cc = message.cc;
    }
    if (message.bcc?.length) {
      body.bcc = message.bcc;
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.resend.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.resend.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      throw new MailDeliveryError(
        describeMailTransportFailure(e),
        this.name,
        true,
        e instanceof Error ? e.message : String(e),
      );
    }

    const rawBody = await response.text().catch(() => '');

    if (!response.ok) {
      const detail = extractMailErrorDetail(rawBody);
      this.logger.warn(`Resend rechazó el envío (${response.status}): ${detail}`);
      throw new MailDeliveryError(
        describeMailHttpFailure(response.status, rawBody),
        this.name,
        isRetriableMailFailure(response.status),
        detail,
      );
    }

    let messageId: string | null = null;
    try {
      const parsed = JSON.parse(rawBody) as { id?: unknown };
      messageId = typeof parsed.id === 'string' ? parsed.id : null;
    } catch {
      // Un 200 sin JSON parseable sigue siendo un envío aceptado.
    }

    return { messageId, provider: this.name, durationMs: Date.now() - started };
  }

  async verify(): Promise<MailDriverHealth> {
    if (!this.isConfigured()) {
      return { healthy: false, detail: 'Falta RESEND_API_KEY en el servidor.', latencyMs: null };
    }

    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.config.resend.baseUrl}/domains`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.config.resend.apiKey}` },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      return { healthy: false, detail: describeMailTransportFailure(e), latencyMs: null };
    }

    const latencyMs = Date.now() - started;
    const rawBody = await response.text().catch(() => '');

    if (response.ok) {
      return { healthy: true, detail: 'Credencial válida y API accesible.', latencyMs };
    }

    // Una llave con permiso SOLO de envío (`sending_access`) no puede listar
    // dominios: Resend responde 401/403 "restricted". Eso NO significa que los
    // correos no vayan a salir — la llave es válida, solo tiene menos permisos.
    // Marcarla como caída dejaría el panel en rojo permanente con todo bien.
    const detail = extractMailErrorDetail(rawBody).toLowerCase();
    if ((response.status === 401 || response.status === 403) && detail.includes('restricted')) {
      return {
        healthy: true,
        detail: 'Credencial válida (llave con permiso solo de envío).',
        latencyMs,
      };
    }

    return {
      healthy: false,
      detail: describeMailHttpFailure(response.status, rawBody),
      latencyMs,
    };
  }
}
