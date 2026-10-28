import {
  SubscriptionPlan,
  SubscriptionStatus,
} from '@/modules/subscriptions/entities/subscription.entity';
import { hasRunningPaidPeriod } from '@/modules/subscriptions/internal/plan-policy';
import { isPaidPlan } from '@/modules/subscriptions/internal/subscription-state';

/**
 * Qué le pasa a una suscripción cuando el dueño pide otro plan.
 *
 * Función PURA y sin BD, porque es la regla que decide quién paga qué. La
 * invariante que protege: **pedir un plan no es tenerlo**. Ningún camino de
 * aquí mueve `plan` ni `expires_at` — eso solo lo hace un pago confirmado
 * (`ApplyWompiTransactionAction`). Si esta función
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
  /** Cambio programado que ya existía (o `null`). */
  current_scheduled_plan: SubscriptionPlan | null;
  /** Fin del período vigente. */
  current_expires_at: Date;
  /** Plan que el dueño acaba de pedir. */
  target_plan: SubscriptionPlan;
  now: Date;
}

export interface PlanTransition {
  status: SubscriptionStatus;
  requested_plan: SubscriptionPlan | null;
  plan_requested_at: Date | null;
  /** Plan que arranca al terminar el período pagado vigente. */
  scheduled_plan: SubscriptionPlan | null;
  plan_scheduled_at: Date | null;
  /** `false` = la petición no cambia nada (pidió lo que ya tiene). */
  changed: boolean;
}

export function resolvePlanTransition(input: PlanTransitionInput): PlanTransition {
  const {
    current_plan,
    current_status,
    current_requested_plan,
    current_scheduled_plan,
    current_expires_at,
    target_plan,
    now,
  } = input;

  // ---------------------------------------------------------------------
  // Volver a `free`: así se cancela. Sirve tanto para retirar una solicitud
  // sin pagar como para dejar de renovar un plan pago (y retira cualquier
  // cambio programado).
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
      scheduled_plan: null,
      plan_scheduled_at: null,
      changed:
        current_requested_plan !== null ||
        current_scheduled_plan !== null ||
        current_status !== status,
    };
  }

  // ---------------------------------------------------------------------
  // Plan de pago VIGENTE: no se compra otro encima. Elegir otro plan solo
  // lo PROGRAMA para cuando termine el período pagado; elegir el mismo
  // retira el cambio programado. Nada queda "pendiente de pago": el plan
  // vigente ya está pagado.
  // ---------------------------------------------------------------------
  if (hasRunningPaidPeriod({ plan: current_plan, expires_at: current_expires_at, now })) {
    const scheduled_plan = target_plan === current_plan ? null : target_plan;
    // Elegir un plan pagado deja de lado una cancelación previa.
    const status = SubscriptionStatus.ACTIVE;
    return {
      status,
      requested_plan: null,
      plan_requested_at: null,
      scheduled_plan,
      plan_scheduled_at: scheduled_plan ? now : null,
      changed:
        scheduled_plan !== current_scheduled_plan ||
        current_requested_plan !== null ||
        current_status !== status,
    };
  }

  // ---------------------------------------------------------------------
  // Sin período pagado (prueba o vencida): la solicitud queda pendiente de
  // pago hasta que Wompi lo confirme.
  // ---------------------------------------------------------------------
  return {
    status: SubscriptionStatus.PAYMENT_PENDING,
    requested_plan: target_plan,
    plan_requested_at: now,
    scheduled_plan: null,
    plan_scheduled_at: null,
    changed:
      current_requested_plan !== target_plan ||
      current_scheduled_plan !== null ||
      current_status !== SubscriptionStatus.PAYMENT_PENDING,
  };
}
