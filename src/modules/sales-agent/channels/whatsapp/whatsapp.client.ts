import { Logger } from '@nestjs/common';

import { chunkText } from '../telegram/telegram.client';

/**
 * Cliente mínimo de la WhatsApp Cloud API (Graph API) sobre `fetch`. Solo lo
 * que usa el vendedor: enviar texto y marcar como leído. El token y el
 * `phone_number_id` se pasan por llamada (vienen de la config del negocio o de
 * la app). El token nunca se registra en logs.
 */
export class WhatsappClient {
  private readonly logger = new Logger(WhatsappClient.name);
  private readonly base: string;

  constructor(private readonly apiVersion: string = 'v21.0') {
    this.base = `https://graph.facebook.com/${this.apiVersion}`;
  }

  /** Envía un mensaje de texto. Trocea si excede el límite de WhatsApp (4096). */
  async sendText(params: {
    phoneNumberId: string;
    to: string;
    text: string;
    token: string;
  }): Promise<boolean> {
    let allOk = true;
    for (const chunk of chunkText(params.text, 4000)) {
      const ok = await this.call(params.phoneNumberId, params.token, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: params.to,
        type: 'text',
        text: { preview_url: false, body: chunk },
      });
      if (!ok) allOk = false;
    }
    return allOk;
  }

  /** Marca un mensaje entrante como leído (los dos chulos azules). Best-effort. */
  async markRead(params: {
    phoneNumberId: string;
    token: string;
    messageId: string;
  }): Promise<void> {
    await this.call(params.phoneNumberId, params.token, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: params.messageId,
    });
  }

  private async call(
    phoneNumberId: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const response = await fetch(`${this.base}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await safeErrorBody(response);
        this.logger.warn(
          { status: response.status, detail, phoneNumberId },
          'WhatsApp respondió con error al enviar',
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error({ err: error, phoneNumberId }, 'Fallo de red hablando con WhatsApp');
      return false;
    }
  }
}

/** Lee el cuerpo de error de Graph sin reventar si no es JSON. */
const safeErrorBody = async (response: Response): Promise<unknown> => {
  try {
    const data = (await response.json()) as { error?: unknown };
    return data?.error ?? data;
  } catch {
    return undefined;
  }
};
