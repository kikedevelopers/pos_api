import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import {
  Subscription,
  SubscriptionStatus,
} from '@/modules/subscriptions/entities/subscription.entity';
import { planSwitchesNow } from '@/modules/subscriptions/internal/plan-policy';

import { BillingAlertsService, type BillingAlert } from '../billing-alerts.service';
import {
  SubscriptionPayment,
  SubscriptionPaymentStatus,
} from '../entities/subscription-payment.entity';
import {
  computeExtension,
  describeRejection,
  evaluateTransaction,
  type TransactionOutcome,
} from '../internal/payment-outcome';
import { WompiClient } from '../wompi/wompi.client';
import type { WompiTransaction } from '../wompi/wompi.types';

/** Quién disparó la aplicación. Solo para el log y las alertas. */
export type ApplySource = 'webhook' | 'return' | 'reconcile';

export interface ApplyResult {
  /** El pago, ya actualizado. `null` si la transacción no es de ningún pago nuestro. */
  payment: SubscriptionPayment | null;
  outcome: TransactionOutcome['kind'] | 'already_applied' | 'unknown_link';
}

/**
 * EL ÚNICO camino por el que un pago carga días a una suscripción.
 *
 * Lo usan los tres disparadores (webhook, regreso del cliente y barrido) y
 * siempre hace lo mismo:
 *
 *   1. Pregunta a Wompi por la transacción con la llave privada. Lo que diga el
 *      webhook o la URL de regreso no se cree: se verifica.
 *   2. Ubica el pago por `payment_link_id` (lo pone Wompi, no el cliente).
 *   3. En UNA transacción SQL bloquea el pago y luego la suscripción (`FOR
 *      UPDATE`, siempre en ese orden → sin interbloqueos), y si la transacción
 *      está aprobada y cuadra, suma los días y marca el pago `approved` con su
 *      `applied_at`. O todo o nada: no existe "aprobado sin días" ni "días sin
 *      pago" (además lo impide un CHECK en la BD).
 *
 * Idempotente: con `applied_at` ya puesto no vuelve a sumar, aunque el webhook
 * llegue cinco veces o el webhook y el regreso lleguen a la vez (el segundo
 * espera el bloqueo y ve el pago ya aplicado).
 *
 * Si algo falla con una transacción APROBADA, se avisa al operador al instante
 * y se relanza el error: el webhook responde 500 (Wompi reintenta) y el barrido
 * lo vuelve a intentar, porque el id de la transacción quedó guardado.
 */
@Injectable()
export class ApplyWompiTransactionAction {
  private readonly logger = new Logger(ApplyWompiTransactionAction.name);

  constructor(
    private readonly wompi: WompiClient,
    private readonly alerts: BillingAlertsService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(SubscriptionPayment)
    private readonly paymentsRepo: Repository<SubscriptionPayment>,
  ) {}

  /** Verifica `transactionId` contra Wompi y lo aplica al pago de su link. */
  async execute(transactionId: string, source: ApplySource): Promise<ApplyResult> {
    const transaction = await this.wompi.getTransaction(transactionId);

    if (!transaction.payment_link_id) {
      // Pagos del mismo comercio que no vienen de un link (otro canal): no son nuestros.
      this.logger.log({ event: 'billing.transaction_without_link', transactionId, source });
      return { payment: null, outcome: 'unknown_link' };
    }

    const payment = await this.paymentsRepo.findOne({
      where: { payment_link_id: transaction.payment_link_id },
    });
    if (!payment) {
      this.logger.warn({
        event: 'billing.unknown_payment_link',
        transactionId,
        paymentLinkId: transaction.payment_link_id,
        source,
      });
      return { payment: null, outcome: 'unknown_link' };
    }

    return this.applyToPayment(payment.id, transaction, source);
  }

  /** Aplica una transacción YA verificada contra Wompi a un pago concreto. */
  async applyToPayment(
    paymentId: string,
    transaction: WompiTransaction,
    source: ApplySource,
  ): Promise<ApplyResult> {
    const pendingAlerts: BillingAlert[] = [];

    // El id de la transacción se guarda ANTES de intentar aplicar: si la
    // transacción SQL de abajo falla, el barrido tiene con qué reintentar.
    if (transaction.payment_link_id) {
      await this.paymentsRepo
        .createQueryBuilder()
        .update(SubscriptionPayment)
        .set({ provider_transaction_id: transaction.id })
        .where('id = :id', { id: paymentId })
        .andWhere('applied_at IS NULL')
        .andWhere('payment_link_id = :linkId', { linkId: transaction.payment_link_id })
        .execute()
        .catch((e: unknown) =>
          this.logger.warn(
            `No se pudo anotar la transacción ${transaction.id} en el pago ${paymentId}: ${String(e)}`,
          ),
        );
    }

    try {
      const result = await this.dataSource.transaction((manager) =>
        this.applyLocked(manager, paymentId, transaction, source, pendingAlerts),
      );
      return result;
    } catch (e) {
      if (transaction.status === 'APPROVED') {
        pendingAlerts.push({
          title: 'Pago APROBADO en Wompi que NO se pudo aplicar (se reintentará)',
          details: {
            pago: paymentId,
            transaccion: transaction.id,
            monto_centavos: transaction.amount_in_cents,
            origen: source,
            error: e instanceof Error ? e.message : String(e),
          },
        });
      }
      throw e;
    } finally {
      for (const alert of pendingAlerts) {
        await this.alerts.notify(alert);
      }
    }
  }

  private async applyLocked(
    manager: EntityManager,
    paymentId: string,
    transaction: WompiTransaction,
    source: ApplySource,
    pendingAlerts: BillingAlert[],
  ): Promise<ApplyResult> {
    const payment = await manager
      .getRepository(SubscriptionPayment)
      .createQueryBuilder('p')
      .setLock('pessimistic_write')
      .where('p.id = :id', { id: paymentId })
      .getOne();
    if (!payment) {
      throw new Error(
        `Pago ${paymentId} no encontrado al aplicar la transacción ${transaction.id}.`,
      );
    }

    const outcome = evaluateTransaction(payment, transaction);
    const now = new Date();

    // Ya aplicado: no se suma nada. Un SEGUNDO aprobado en un link de un solo
    // uso no debería existir; si existe, alguien pagó dos veces → revisión.
    if (payment.applied_at) {
      if (outcome.kind === 'approve' && payment.provider_transaction_id !== transaction.id) {
        pendingAlerts.push({
          title: 'Segunda transacción APROBADA en un link ya aplicado (posible doble cobro)',
          details: {
            pago: payment.id,
            referencia: payment.reference,
            transaccion_aplicada: payment.provider_transaction_id,
            transaccion_nueva: transaction.id,
            monto_centavos: transaction.amount_in_cents,
          },
        });
      }
      return { payment, outcome: 'already_applied' };
    }

    payment.last_checked_at = now;

    if (outcome.kind === 'foreign') {
      this.logger.warn({ event: 'billing.foreign_transaction', paymentId, reason: outcome.reason });
      await manager.save(SubscriptionPayment, payment);
      return { payment, outcome: outcome.kind };
    }

    this.recordProviderFields(payment, transaction);

    if (outcome.kind === 'pending') {
      // `needs_review` no se pisa con un pendiente: lo que está en revisión espera al operador.
      if (payment.status !== SubscriptionPaymentStatus.NEEDS_REVIEW) {
        payment.status = SubscriptionPaymentStatus.PENDING;
      }
      await manager.save(SubscriptionPayment, payment);
      return { payment, outcome: outcome.kind };
    }

    if (outcome.kind === 'needs_review') {
      payment.status = SubscriptionPaymentStatus.NEEDS_REVIEW;
      payment.failure_reason = outcome.reason;
      await manager.save(SubscriptionPayment, payment);
      pendingAlerts.push({
        title: 'Pago APROBADO que no cuadra: NO se cargaron días',
        details: {
          pago: payment.id,
          referencia: payment.reference,
          empresa: payment.company_id,
          transaccion: transaction.id,
          motivo: outcome.reason,
          origen: source,
        },
      });
      return { payment, outcome: outcome.kind };
    }

    const subscription = await manager
      .getRepository(Subscription)
      .createQueryBuilder('s')
      .setLock('pessimistic_write')
      .where('s.id = :id', { id: payment.subscription_id })
      .getOne();
    if (!subscription) {
      throw new Error(`Suscripción ${payment.subscription_id} del pago ${payment.id} no existe.`);
    }

    if (outcome.kind === 'reject') {
      if (payment.status !== SubscriptionPaymentStatus.NEEDS_REVIEW) {
        payment.status = outcome.status;
        payment.failure_reason = describeRejection(outcome.status, transaction.status_message);
      }
      await manager.save(SubscriptionPayment, payment);

      // La suscripción solo se marca "pago fallido" si estaba esperando ESTE
      // plan. Una renovación rechazada de un plan vigente no le quita nada.
      if (
        subscription.status === SubscriptionStatus.PAYMENT_PENDING &&
        subscription.requested_plan === payment.plan
      ) {
        await manager.update(Subscription, subscription.id, {
          status: SubscriptionStatus.PAYMENT_FAILED,
        });
      }
      this.logger.log({
        event: 'billing.payment_rejected',
        paymentId: payment.id,
        transactionId: transaction.id,
        status: outcome.status,
        source,
      });
      return { payment, outcome: outcome.kind };
    }

    // ---- approve: días + plan + pago, todo en esta transacción ----
    // Los días van DESPUÉS de lo que le quede. Si tenía otro plan de pago
    // vigente (renovación con cambio de plan), ese plan se respeta hasta su
    // corte: el nuevo lo promueve el barrido cuando empiece este período.
    // Aunque el pago llegue fuera de la ventana de renovación (un link viejo),
    // se aplica igual: si pagó, se le cargan los días.
    const extension = computeExtension(subscription.expires_at, payment.days_granted, now);
    const switchesNow = planSwitchesNow({
      plan: subscription.plan,
      expires_at: subscription.expires_at,
      now,
      paid_plan: payment.plan,
    });

    await manager.update(Subscription, subscription.id, {
      expires_at: extension.period_ends_at,
      started_at: extension.was_expired ? now : subscription.started_at,
      plan: switchesNow ? payment.plan : subscription.plan,
      status: SubscriptionStatus.ACTIVE,
      // Pagó: no queda nada pendiente ni programado (lo pagado ES el plan
      // del siguiente período).
      requested_plan: null,
      plan_requested_at: null,
      scheduled_plan: null,
      plan_scheduled_at: null,
    });

    payment.status = SubscriptionPaymentStatus.APPROVED;
    payment.failure_reason = null;
    payment.applied_at = now;
    payment.period_starts_at = extension.period_starts_at;
    payment.period_ends_at = extension.period_ends_at;
    await manager.save(SubscriptionPayment, payment);

    this.logger.log({
      event: 'billing.payment_applied',
      paymentId: payment.id,
      companyId: payment.company_id,
      plan: payment.plan,
      planSwitchesNow: switchesNow,
      days: payment.days_granted,
      transactionId: transaction.id,
      periodEndsAt: extension.period_ends_at.toISOString(),
      source,
    });
    return { payment, outcome: 'approve' };
  }

  private recordProviderFields(payment: SubscriptionPayment, transaction: WompiTransaction): void {
    payment.provider_transaction_id = transaction.id;
    payment.provider_status = String(transaction.status).slice(0, 20);
    payment.provider_status_message = transaction.status_message ?? null;
    payment.payment_method_type = transaction.payment_method_type
      ? String(transaction.payment_method_type).slice(0, 40)
      : null;
  }
}
