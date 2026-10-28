import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';

import { toPaymentResponseDto, type PaymentResponseDto } from '../dto/payment-response.dto';
import { SubscriptionPayment } from '../entities/subscription-payment.entity';

import { ApplyWompiTransactionAction } from './apply-wompi-transaction.action';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Estado de un pago para la pantalla de regreso del portal (`/panel/pago`).
 *
 * Si trae `transaction_id` (el `?id=` que Wompi añade al volver) o el pago ya
 * conoce su transacción, se VERIFICA contra Wompi en ese momento: así el dueño
 * ve sus días cargados sin esperar al webhook. El id que manda el navegador no
 * se cree: `ApplyWompiTransactionAction` consulta a Wompi y solo aplica si la
 * transacción pertenece al link de ESTE pago.
 *
 * Una caída de Wompi aquí NO es un error para el usuario: se devuelve el
 * estado conocido (pendiente) y la pantalla sigue consultando. El webhook y el
 * barrido terminan el trabajo.
 */
@Injectable()
export class ConfirmPaymentAction {
  private readonly logger = new Logger(ConfirmPaymentAction.name);

  constructor(
    private readonly applyTransaction: ApplyWompiTransactionAction,
    private readonly subscriptionsService: SubscriptionsService,
    @InjectRepository(SubscriptionPayment)
    private readonly paymentsRepo: Repository<SubscriptionPayment>,
  ) {}

  async execute(
    userId: number,
    companyId: number,
    reference: string,
    transactionId?: string,
  ): Promise<PaymentResponseDto> {
    const payment = await this.findOwned(userId, companyId, reference);

    const candidate = transactionId ?? payment.provider_transaction_id;
    if (!payment.applied_at && candidate) {
      try {
        const result = await this.applyTransaction.execute(candidate, 'return');
        if (result.payment && result.payment.id !== payment.id) {
          this.logger.warn({
            event: 'billing.return_transaction_mismatch',
            reference,
            transactionId: candidate,
          });
        }
      } catch (e) {
        this.logger.warn({
          event: 'billing.return_verification_deferred',
          reference,
          transactionId: candidate,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const fresh = await this.paymentsRepo.findOneOrFail({ where: { id: payment.id } });
    return toPaymentResponseDto(fresh);
  }

  /** El pago, solo si es de la suscripción de este titular. 404 si no (no se revela que existe). */
  async findOwned(
    userId: number,
    companyId: number,
    reference: string,
  ): Promise<SubscriptionPayment> {
    // TypeORM IGNORA las condiciones `undefined`: sin esta guarda, una referencia
    // vacía devolvería el primer pago de la suscripción.
    if (typeof reference !== 'string' || !UUID_PATTERN.test(reference)) {
      throw new NotFoundException('Pago no encontrado');
    }
    const subscription = await this.subscriptionsService.findApplicable(companyId);
    if (!subscription) {
      throw new NotFoundException('Suscripción no encontrada');
    }
    if (subscription.owner_user_id !== String(userId)) {
      throw new ForbiddenException({
        message: 'Solo el titular de la cuenta puede ver sus pagos.',
        payload: { code: 'PORTAL_OWNER_ONLY' },
      });
    }

    const payment = await this.paymentsRepo.findOne({
      where: { reference, subscription_id: subscription.id },
    });
    if (!payment) {
      throw new NotFoundException('Pago no encontrado');
    }
    return payment;
  }
}
