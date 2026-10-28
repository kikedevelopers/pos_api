import { addDays } from '../subscriptions.constants';
import type { SubscriptionPlan } from '../entities/subscription.entity';

import { isPaidPlan } from './subscription-state';

/**
 * Control de plan: cuándo se puede pagar y cuándo un cambio solo se PROGRAMA.
 *
 * Regla de negocio:
 *   - Con un plan de pago vigente NO se compra otro plan encima. Se puede
 *     cambiar de plan, pero el cambio arranca al terminar el período pagado.
 *   - Faltando `RENEWAL_WINDOW_DAYS` días o más para el corte, el cambio solo
 *     se anota (`scheduled_plan`): no se cobra nada todavía.
 *   - Faltando menos, se abre la renovación: el siguiente cobro se puede pagar
 *     ya, y sus días se suman DESPUÉS del corte con el plan elegido.
 *   - Sin plan de pago vigente (prueba gratis o vencida) se paga y aplica ya.
 *
 * Función PURA: decide si se le cobra a alguien, así que vive sin BD y con un
 * test por rama.
 */
export const RENEWAL_WINDOW_DAYS = 30;

export interface PlanPolicyInput {
  plan: SubscriptionPlan;
  expires_at: Date;
  now: Date;
}

/** Hay un período PAGADO corriendo (no la prueba, no vencido). */
export const hasRunningPaidPeriod = ({ plan, expires_at, now }: PlanPolicyInput): boolean =>
  isPaidPlan(plan) && expires_at.getTime() > now.getTime();

/** Desde cuándo se puede pagar el siguiente período. */
export const renewalOpensAt = (expires_at: Date): Date => addDays(expires_at, -RENEWAL_WINDOW_DAYS);

export type CheckoutDecision =
  | {
      allowed: true;
      /**
       * `now`: el plan pagado aplica de inmediato (prueba o vencida).
       * `at_period_end`: renovación; el plan cambia al terminar el período vigente.
       */
      plan_switch: 'now' | 'at_period_end';
    }
  | {
      allowed: false;
      code: 'RENEWAL_NOT_OPEN';
      renewal_opens_at: Date;
      period_ends_at: Date;
    };

/** ¿Se puede abrir un pago ahora? */
export function resolveCheckoutDecision(input: PlanPolicyInput): CheckoutDecision {
  if (!hasRunningPaidPeriod(input)) {
    return { allowed: true, plan_switch: 'now' };
  }
  const opensAt = renewalOpensAt(input.expires_at);
  // "Le queda exactamente un mes o más" → todavía no se cobra.
  if (input.now.getTime() <= opensAt.getTime()) {
    return {
      allowed: false,
      code: 'RENEWAL_NOT_OPEN',
      renewal_opens_at: opensAt,
      period_ends_at: input.expires_at,
    };
  }
  return { allowed: true, plan_switch: 'at_period_end' };
}

/**
 * Al aprobarse un pago: ¿el plan de la suscripción cambia ya o espera al corte?
 *
 * Cambia ya si no había un período pagado corriendo (la prueba gratis no se
 * respeta como "plan": quien paga, pasa al plan pagado y conserva los días de
 * prueba) o si el plan es el mismo. Si es OTRO plan con período vigente, el
 * plan actual se respeta hasta el corte y lo promueve el barrido.
 */
export function planSwitchesNow(input: PlanPolicyInput & { paid_plan: SubscriptionPlan }): boolean {
  return !hasRunningPaidPeriod(input) || input.plan === input.paid_plan;
}
