import {
  SubscriptionPlan,
  SubscriptionStatus,
} from '@/modules/subscriptions/entities/subscription.entity';
import { isPaidPlan } from '@/modules/subscriptions/internal/subscription-state';

/**
 * Qué le pasa a una suscripción cuando el dueño pide otro plan.
 *
 * Función PURA y sin BD, porque es la regla que decide quién paga qué. La
 * invariante que protege: **pedir un plan no es tenerlo**. Ningún camino de
 * aquí mueve `plan` ni `expires_at` — eso solo lo hace un pago confirmado
 * (hoy, el operador; mañana, el webhook de la pasarela). Si esta función
 * pudiera ascender el plan, hacer clic en "Quiero el anual" sería el anual
 * gratis.
 */
export interface PlanTransitionInput {
  /** Plan vigente hoy. */
  current_plan: SubscriptionPlan;
  /** Estado de cobro almacenado hoy. */
  current_status: SubscriptionStatus;
  /** Solicitud pendiente que ya existía (o `null`). */
  current_requested_plan: SubscriptionPlan | null;
  /** Plan que el dueño acaba de pedir. */
  target_plan: SubscriptionPlan;
  now: Date;
}

export interface PlanTransition {
  status: SubscriptionStatus;
  requested_plan: SubscriptionPlan | null;
  plan_requested_at: Date | null;
  /** `false` = la petición no cambia nada (pidió lo que ya tiene). */
  changed: boolean;
}

export function resolvePlanTransition(input: PlanTransitionInput): PlanTransition {
  const { current_plan, current_status, current_requested_plan, target_plan, now } = input;

  // ---------------------------------------------------------------------
  // Volver a `free`: así se cancela. Sirve tanto para retirar una solicitud
  // sin pagar como para dejar de renovar un plan pago.
  // ---------------------------------------------------------------------
  if (target_plan === SubscriptionPlan.FREE) {
    // Con plan pago, `canceled`: sigue funcionando hasta `expires_at` — ya
    // está pagado— y no se renueva. Quitarle el servicio el mismo día en que
    // cancela sería cobrarle un mes y darle medio.
    const status = isPaidPlan(current_plan)
      ? SubscriptionStatus.CANCELED
      : SubscriptionStatus.TRIALING;

    return {
      status,
      requested_plan: null,
      plan_requested_at: null,
      changed: current_requested_plan !== null || current_status !== status,
    };
  }

  // ---------------------------------------------------------------------
  // Plan de pago. Ya lo tiene y está al día y sin nada pendiente → no-op:
  // no se le abre una solicitud de pago a quien ya pagó eso mismo.
  // ---------------------------------------------------------------------
  const alreadyOnIt =
    current_plan === target_plan &&
    current_status === SubscriptionStatus.ACTIVE &&
    current_requested_plan === null;

  if (alreadyOnIt) {
    return {
      status: current_status,
      requested_plan: current_requested_plan,
      plan_requested_at: null,
      changed: false,
    };
  }

  // Solicitud (o reintento tras un pago rebotado): queda pendiente de pago.
  return {
    status: SubscriptionStatus.PAYMENT_PENDING,
    requested_plan: target_plan,
    plan_requested_at: now,
    changed:
      current_requested_plan !== target_plan ||
      current_status !== SubscriptionStatus.PAYMENT_PENDING,
  };
}
