import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';

import { BillingAlertsService } from '../billing-alerts.service';
import { verifyEventSignature } from '../internal/wompi-signature';
import { WompiClient } from '../wompi/wompi.client';
import type { WompiEvent } from '../wompi/wompi.types';

import { ApplyWompiTransactionAction, type ApplyResult } from './apply-wompi-transaction.action';

/**
 * Webhook de Wompi (`transaction.updated`).
 *
 *   1. Firma: si no cuadra con el secreto de eventos, 401 y alerta. Nadie
 *      puede "aprobar" un pago llamando al webhook.
 *   2. Ambiente: un evento de sandbox no toca un servidor en producción ni al
 *      revés.
 *   3. Aun con firma válida, la transacción se vuelve a consultar a Wompi
 *      (`ApplyWompiTransactionAction`): el evento solo dice "mira esta".
 *
 * Si aplicar falla, el error sube → 500 → Wompi reintenta (30 min, 3 h, 24 h).
 */
@Injectable()
export class HandleWompiEventAction {
  private readonly logger = new Logger(HandleWompiEventAction.name);

  constructor(
    private readonly wompi: WompiClient,
    private readonly applyTransaction: ApplyWompiTransactionAction,
    private readonly alerts: BillingAlertsService,
  ) {}

  async execute(
    event: WompiEvent,
    headerChecksum?: string | null,
  ): Promise<{ received: true; outcome: ApplyResult['outcome'] | 'ignored' }> {
    this.wompi.assertConfigured();
    const config = this.wompi.config;

    if (!verifyEventSignature(event, config.eventsSecret, headerChecksum)) {
      await this.alerts.notify({
        title: 'Webhook de Wompi con firma inválida (rechazado)',
        details: {
          evento: typeof event?.event === 'string' ? event.event : '(sin nombre)',
          transaccion: String(event?.data?.transaction?.id ?? '—'),
        },
      });
      throw new UnauthorizedException('Firma del evento inválida.');
    }

    const expectedEnvironment = config.environment === 'production' ? 'prod' : 'test';
    if (event.environment && event.environment !== expectedEnvironment) {
      this.logger.warn({
        event: 'billing.webhook_wrong_environment',
        received: event.environment,
        expected: expectedEnvironment,
      });
      return { received: true, outcome: 'ignored' };
    }

    if (event.event !== 'transaction.updated') {
      return { received: true, outcome: 'ignored' };
    }

    const transactionId = event.data?.transaction?.id;
    if (typeof transactionId !== 'string' || !transactionId) {
      return { received: true, outcome: 'ignored' };
    }

    const result = await this.applyTransaction.execute(transactionId, 'webhook');
    return { received: true, outcome: result.outcome };
  }
}
