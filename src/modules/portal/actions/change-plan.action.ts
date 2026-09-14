import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import {
  SubscriptionResponseDto,
  toSubscriptionResponseDto,
} from '@/modules/subscriptions/dto/subscription-response.dto';
import {
  Subscription,
  SubscriptionPlan,
} from '@/modules/subscriptions/entities/subscription.entity';
import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';

import { resolvePlanTransition } from '../internal/plan-transition';

/**
 * Cambio de plan desde el portal.
 *
 * Guarda la INTENCIÓN, nunca el privilegio: un plan de pago queda
 * `payment_pending` hasta que un pago confirmado lo promueva. Ni `plan` ni
 * `expires_at` se tocan aquí.
 *
 * Volver a `free` sí es inmediato (retira la solicitud pendiente o marca la
 * no-renovación): cancelar no le regala nada a nadie.
 */
@Injectable()
export class ChangePlanAction {
  private readonly logger = new Logger(ChangePlanAction.name);

  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    @InjectRepository(Subscription)
    private readonly repo: Repository<Subscription>,
  ) {}

  async execute(
    userId: number,
    companyId: number,
    targetPlan: SubscriptionPlan,
  ): Promise<SubscriptionResponseDto> {
    const subscription = await this.subscriptionsService.findApplicable(companyId);
    if (!subscription) {
      throw new NotFoundException('Suscripción no encontrada');
    }

    // La suscripción es del dueño que la originó. `findApplicable` ya resuelve
    // por la company del JWT, pero este chequeo cierra el caso de un token de
    // otra membresía: quien cambia el plan tiene que ser el titular del cobro.
    if (subscription.owner_user_id !== String(userId)) {
      throw new ForbiddenException({
        message: 'Solo el titular de la cuenta puede cambiar el plan.',
        payload: { code: 'PORTAL_OWNER_ONLY' },
      });
    }

    const transition = resolvePlanTransition({
      current_plan: subscription.plan,
      current_status: subscription.status,
      current_requested_plan: subscription.requested_plan,
      target_plan: targetPlan,
      now: new Date(),
    });

    // Se escribe siempre (aunque `changed` sea false): la transición es
    // idempotente y así una fila con un `plan_requested_at` colgado de una
    // solicitud ya retirada queda limpia.
    await this.repo.update(subscription.id, {
      status: transition.status,
      requested_plan: transition.requested_plan,
      plan_requested_at: transition.plan_requested_at,
    });

    this.logger.log({
      event: 'portal.plan_change_requested',
      userId,
      companyId,
      currentPlan: subscription.plan,
      targetPlan,
      status: transition.status,
      changed: transition.changed,
    });

    return toSubscriptionResponseDto({
      ...subscription,
      status: transition.status,
      requested_plan: transition.requested_plan,
      plan_requested_at: transition.plan_requested_at,
    });
  }
}
