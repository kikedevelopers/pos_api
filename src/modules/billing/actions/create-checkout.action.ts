import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { MoreThan, type DataSource, type Repository } from 'typeorm';

import { APP_TIMEZONE } from '@/common/utils/dayjs';
import { resolvePlanTransition } from '@/modules/portal/internal/plan-transition';
import {
  Subscription,
  type SubscriptionPlan,
} from '@/modules/subscriptions/entities/subscription.entity';
import { resolveCheckoutDecision } from '@/modules/subscriptions/internal/plan-policy';
import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';

import {
  BILLING_CURRENCY,
  PAYMENT_LINK_REUSE_MIN_REMAINING_MS,
  PAYMENT_LINK_TTL_MS,
  termsForPlan,
} from '../billing.constants';
import { toPaymentResponseDto, type PaymentResponseDto } from '../dto/payment-response.dto';
import {
  SubscriptionPayment,
  SubscriptionPaymentStatus,
} from '../entities/subscription-payment.entity';
import { WompiApiError, WompiClient } from '../wompi/wompi.client';

/**
 * Abre el pago de un plan: crea (o reutiliza) un link de pago de Wompi de UN
 * SOLO USO con el monto fijado por el servidor y devuelve su URL.
 *
 * Orden deliberado:
 *   1. Se valida todo (plan de pago, titular, suscripción) y el control de
 *      plan: con un plan de pago vigente y un mes o más por delante NO se
 *      cobra (409 `RENEWAL_NOT_OPEN`); el cambio de plan se programa aparte.
 *      Dentro del último mes, el pago es la renovación: sus días van DESPUÉS
 *      del corte y el plan cambia al terminar el período vigente.
 *   2. Si hay un link pendiente del mismo plan con vida suficiente, se devuelve
 *      ese: varios clics no deben abrir varios cobros.
 *   3. Se crea el link en Wompi (fuera de la transacción SQL: no se retiene un
 *      bloqueo mientras se espera a la red).
 *   4. En una transacción: se registra el pago y la suscripción queda
 *      `payment_pending` con el plan pedido. La URL solo se devuelve si esto
 *      se guardó; un link que no está en la BD nunca llega al cliente, así que
 *      no puede existir un pago que no sepamos a quién acreditar.
 */
@Injectable()
export class CreateCheckoutAction {
  private readonly logger = new Logger(CreateCheckoutAction.name);

  constructor(
    private readonly wompi: WompiClient,
    private readonly subscriptionsService: SubscriptionsService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(SubscriptionPayment)
    private readonly paymentsRepo: Repository<SubscriptionPayment>,
  ) {}

  async execute(userId: number, companyId: number, plan: string): Promise<PaymentResponseDto> {
    const terms = termsForPlan(plan);
    if (!terms) {
      throw new BadRequestException({
        message: 'Ese plan no se paga en línea.',
        payload: { code: 'PLAN_NOT_PAYABLE' },
      });
    }
    this.wompi.assertConfigured();

    const subscription = await this.subscriptionsService.findApplicable(companyId);
    if (!subscription) {
      throw new NotFoundException('Suscripción no encontrada');
    }
    if (subscription.owner_user_id !== String(userId)) {
      throw new ForbiddenException({
        message: 'Solo el titular de la cuenta puede pagar la suscripción.',
        payload: { code: 'PORTAL_OWNER_ONLY' },
      });
    }

    const now = new Date();
    this.assertCheckoutAllowed(subscription, now);

    const reusable = await this.paymentsRepo.findOne({
      where: {
        subscription_id: subscription.id,
        plan: terms.plan,
        status: SubscriptionPaymentStatus.PENDING,
        amount_in_cents: String(terms.amount_in_cents),
        provider_environment: this.wompi.config.environment,
        link_expires_at: MoreThan(new Date(now.getTime() + PAYMENT_LINK_REUSE_MIN_REMAINING_MS)),
      },
      order: { created_at: 'DESC' },
    });
    if (reusable && !reusable.provider_transaction_id) {
      return toPaymentResponseDto(reusable);
    }

    const reference = randomUUID();
    const expiresAt = new Date(now.getTime() + PAYMENT_LINK_TTL_MS);
    const returnUrl = `${this.wompi.config.returnUrl}/panel/pago?ref=${reference}`;

    let link;
    try {
      link = await this.wompi.createPaymentLink({
        name: `PlacePOS · Plan ${terms.name}`,
        description: `Suscripción PlacePOS plan ${terms.name} (${terms.days} días)`,
        amount_in_cents: terms.amount_in_cents,
        currency: BILLING_CURRENCY,
        redirect_url: returnUrl,
        expires_at: expiresAt,
        sku: reference,
      });
    } catch (e) {
      this.logger.error({
        event: 'billing.payment_link_failed',
        companyId,
        plan: terms.plan,
        error: e instanceof Error ? e.message : String(e),
      });
      if (e instanceof WompiApiError) {
        throw new BadGatewayException({
          message: 'No pudimos abrir la pasarela de pago. Intenta de nuevo en unos minutos.',
          payload: { code: 'PAYMENT_GATEWAY_ERROR' },
        });
      }
      throw e;
    }

    const payment = await this.dataSource.transaction(async (manager) => {
      const locked = await manager
        .getRepository(Subscription)
        .createQueryBuilder('s')
        .setLock('pessimistic_write')
        .where('s.id = :id', { id: subscription.id })
        .getOneOrFail();

      // Otra vez, ya con la fila bloqueada: un pago aplicado mientras se
      // creaba el link pudo cerrar la ventana de renovación. El link creado
      // en Wompi no llega al cliente, así que nadie lo puede pagar.
      this.assertCheckoutAllowed(locked, now);

      // Sin plan vigente: queda `payment_pending` con el plan pedido. Con plan
      // vigente (renovación): el plan elegido queda programado para el corte;
      // el estado sigue activo porque lo vigente ya está pagado.
      const transition = resolvePlanTransition({
        current_plan: locked.plan,
        current_status: locked.status,
        current_requested_plan: locked.requested_plan,
        current_scheduled_plan: locked.scheduled_plan ?? null,
        current_expires_at: locked.expires_at,
        target_plan: terms.plan,
        now,
      });
      if (transition.changed) {
        await manager.update(Subscription, locked.id, {
          status: transition.status,
          requested_plan: transition.requested_plan,
          plan_requested_at: transition.plan_requested_at,
          scheduled_plan: transition.scheduled_plan,
          plan_scheduled_at: transition.plan_scheduled_at,
        });
      }

      return manager.save(
        SubscriptionPayment,
        manager.create(SubscriptionPayment, {
          reference,
          company_id: locked.company_id,
          subscription_id: locked.id,
          owner_user_id: String(userId),
          plan: terms.plan,
          amount_in_cents: String(terms.amount_in_cents),
          currency: BILLING_CURRENCY,
          days_granted: terms.days,
          provider: 'wompi',
          provider_environment: this.wompi.config.environment,
          payment_link_id: link.id,
          checkout_url: this.wompi.checkoutUrl(link.id),
          link_expires_at: expiresAt,
          status: SubscriptionPaymentStatus.PENDING,
        }),
      );
    });

    this.logger.log({
      event: 'billing.checkout_created',
      companyId,
      userId,
      plan: terms.plan,
      paymentId: payment.id,
      paymentLinkId: link.id,
    });
    return toPaymentResponseDto(payment);
  }

  /**
   * Con un plan de pago vigente y un mes o más por delante, no se cobra: no se
   * compra un plan encima de otro. El cliente recibe cuándo se abre la
   * renovación para decírselo al dueño.
   */
  private assertCheckoutAllowed(
    subscription: Pick<Subscription, 'plan' | 'expires_at'>,
    now: Date,
  ): void {
    const decision = resolveCheckoutDecision({
      plan: subscription.plan,
      expires_at: subscription.expires_at,
      now,
    });
    if (decision.allowed) {
      return;
    }
    throw new ConflictException({
      message:
        `Ya tienes el plan ${planName(subscription.plan)} activo hasta el ${formatLongDate(decision.period_ends_at)}. ` +
        `Podrás pagar el siguiente período desde el ${formatLongDate(decision.renewal_opens_at)}. ` +
        'Si quieres otro plan, prográmalo: empieza al terminar el actual.',
      payload: {
        code: decision.code,
        renewal_opens_at: decision.renewal_opens_at.toISOString(),
        period_ends_at: decision.period_ends_at.toISOString(),
      },
    });
  }
}

const planName = (plan: SubscriptionPlan): string => termsForPlan(plan)?.name ?? 'actual';

/** "31 de diciembre de 2027", en la hora de Colombia. */
const formatLongDate = (date: Date): string =>
  new Intl.DateTimeFormat('es-CO', {
    timeZone: APP_TIMEZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
