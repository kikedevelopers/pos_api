import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { BillingConfig } from '@/config/billing.config';

import type { CreatePaymentLinkInput, WompiPaymentLink, WompiTransaction } from './wompi.types';

/** Fallo hablando con Wompi. `status` = HTTP (0 si ni siquiera respondió). */
export class WompiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WompiApiError';
  }
}

/**
 * Cliente mínimo del API de Wompi. Solo lo que usa el cobro de la suscripción:
 * crear un link de pago y consultar una transacción.
 *
 * La consulta de transacción es la FUENTE DE VERDAD del módulo: ni el webhook
 * ni el `?id=` del regreso se creen por sí solos; siempre se vuelve a preguntar
 * a Wompi con la llave privada antes de cargar un solo día.
 */
@Injectable()
export class WompiClient {
  private readonly logger = new Logger(WompiClient.name);

  constructor(private readonly configService: ConfigService) {}

  get config(): BillingConfig {
    return this.configService.getOrThrow<BillingConfig>('billing');
  }

  /** Lanza 503 legible si faltan llaves: nunca se intenta un cobro a medias. */
  assertConfigured(): void {
    const config = this.config;
    if (!config.configured) {
      this.logger.error(`Cobro con Wompi deshabilitado: ${config.configurationError}`);
      throw new ServiceUnavailableException({
        message: 'Los pagos en línea no están disponibles en este momento. Intenta más tarde.',
        payload: { code: 'BILLING_UNAVAILABLE' },
      });
    }
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<WompiPaymentLink> {
    this.assertConfigured();
    const body = {
      name: input.name,
      description: input.description,
      single_use: true,
      collect_shipping: false,
      currency: input.currency,
      amount_in_cents: input.amount_in_cents,
      redirect_url: input.redirect_url,
      // Wompi espera ISO 8601; se manda en UTC explícito.
      expires_at: input.expires_at.toISOString(),
      sku: input.sku.slice(0, 36),
    };
    const data = await this.request<WompiPaymentLink>('POST', '/payment_links', body);
    if (!data?.id) {
      throw new WompiApiError('Wompi no devolvió el id del link de pago.', 502);
    }
    return data;
  }

  async getTransaction(transactionId: string): Promise<WompiTransaction> {
    this.assertConfigured();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(transactionId)) {
      throw new WompiApiError('Id de transacción inválido.', 400);
    }
    const data = await this.request<WompiTransaction>(
      'GET',
      `/transactions/${encodeURIComponent(transactionId)}`,
    );
    if (!data?.id || typeof data.amount_in_cents !== 'number') {
      throw new WompiApiError('Wompi devolvió una transacción incompleta.', 502);
    }
    return data;
  }

  /** URL pública del checkout de un link. */
  checkoutUrl(linkId: string): string {
    return `https://checkout.wompi.co/l/${encodeURIComponent(linkId)}`;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const config = this.config;
    let response: Response;
    try {
      response = await fetch(`${config.apiBaseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.privateKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (e) {
      throw new WompiApiError(
        `No se pudo contactar a Wompi (${method} ${path}): ${e instanceof Error ? e.message : String(e)}`,
        0,
      );
    }

    const json = (await response.json().catch(() => null)) as {
      data?: T;
      error?: { type?: string; reason?: string; messages?: unknown };
    } | null;

    if (!response.ok) {
      const detail = json?.error
        ? `${json.error.type ?? ''} ${json.error.reason ?? ''} ${
            json.error.messages ? JSON.stringify(json.error.messages) : ''
          }`.trim()
        : `HTTP ${response.status}`;
      throw new WompiApiError(
        `Wompi respondió ${response.status} en ${method} ${path}: ${detail}`,
        response.status,
      );
    }
    return json?.data as T;
  }
}
