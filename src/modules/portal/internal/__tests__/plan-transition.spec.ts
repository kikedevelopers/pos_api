import {
  SubscriptionPlan,
  SubscriptionStatus,
} from '@/modules/subscriptions/entities/subscription.entity';

import { resolvePlanTransition } from '../plan-transition';

// ---------------------------------------------------------------------------
// Qué pasa cuando el dueño elige un plan.
//
// La invariante que se prueba aquí una y otra vez es una sola: **pedir no es
// tener**. Si alguna transición ascendiera el plan, el botón "Quiero el anual"
// sería el plan anual gratis, y nadie volvería a pagar.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-15T12:00:00.000Z');

const transition = (input: {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  requested?: SubscriptionPlan | null;
  target: SubscriptionPlan;
}) =>
  resolvePlanTransition({
    current_plan: input.plan,
    current_status: input.status,
    current_requested_plan: input.requested ?? null,
    target_plan: input.target,
    now: NOW,
  });

describe('pedir un plan de pago', () => {
  it('desde la prueba, deja el cobro pendiente y NO cambia el plan', () => {
    const result = transition({
      plan: SubscriptionPlan.FREE,
      status: SubscriptionStatus.TRIALING,
      target: SubscriptionPlan.ANNUAL,
    });

    expect(result.status).toBe(SubscriptionStatus.PAYMENT_PENDING);
    expect(result.requested_plan).toBe(SubscriptionPlan.ANNUAL);
    expect(result.plan_requested_at).toEqual(NOW);
    expect(result.changed).toBe(true);
    // El resultado NO trae `plan`: la función no puede tocarlo ni queriendo.
    expect(result).not.toHaveProperty('plan');
  });

  it('cambiar de mensual a anual también queda pendiente de pago', () => {
    const result = transition({
      plan: SubscriptionPlan.MONTHLY,
      status: SubscriptionStatus.ACTIVE,
      target: SubscriptionPlan.ANNUAL,
    });

    expect(result.status).toBe(SubscriptionStatus.PAYMENT_PENDING);
    expect(result.requested_plan).toBe(SubscriptionPlan.ANNUAL);
    expect(result.changed).toBe(true);
  });

  it('bajar de anual a mensual sigue el mismo camino: se pide, no se aplica', () => {
    const result = transition({
      plan: SubscriptionPlan.ANNUAL,
      status: SubscriptionStatus.ACTIVE,
      target: SubscriptionPlan.MONTHLY,
    });

    expect(result.status).toBe(SubscriptionStatus.PAYMENT_PENDING);
    expect(result.requested_plan).toBe(SubscriptionPlan.MONTHLY);
  });

  it('tras un pago rebotado, volver a pedir el mismo plan es un reintento', () => {
    const result = transition({
      plan: SubscriptionPlan.FREE,
      status: SubscriptionStatus.PAYMENT_FAILED,
      requested: SubscriptionPlan.MONTHLY,
      target: SubscriptionPlan.MONTHLY,
    });

    expect(result.status).toBe(SubscriptionStatus.PAYMENT_PENDING);
    expect(result.requested_plan).toBe(SubscriptionPlan.MONTHLY);
    expect(result.changed).toBe(true);
  });

  it('pedir dos veces lo mismo estando pendiente no cuenta como cambio', () => {
    const result = transition({
      plan: SubscriptionPlan.FREE,
      status: SubscriptionStatus.PAYMENT_PENDING,
      requested: SubscriptionPlan.ANNUAL,
      target: SubscriptionPlan.ANNUAL,
    });

    expect(result.changed).toBe(false);
    expect(result.status).toBe(SubscriptionStatus.PAYMENT_PENDING);
    expect(result.requested_plan).toBe(SubscriptionPlan.ANNUAL);
  });

  it('pedir el plan que ya se tiene pagado no abre una solicitud de cobro', () => {
    const result = transition({
      plan: SubscriptionPlan.ANNUAL,
      status: SubscriptionStatus.ACTIVE,
      target: SubscriptionPlan.ANNUAL,
    });

    expect(result.changed).toBe(false);
    expect(result.status).toBe(SubscriptionStatus.ACTIVE);
    expect(result.requested_plan).toBeNull();
  });

  it('si el plan pagado estaba cancelado, volver a pedirlo lo reactiva como pendiente', () => {
    const result = transition({
      plan: SubscriptionPlan.ANNUAL,
      status: SubscriptionStatus.CANCELED,
      target: SubscriptionPlan.ANNUAL,
    });

    expect(result.status).toBe(SubscriptionStatus.PAYMENT_PENDING);
    expect(result.requested_plan).toBe(SubscriptionPlan.ANNUAL);
    expect(result.changed).toBe(true);
  });
});

describe('volver a free', () => {
  it('retira la solicitud pendiente y devuelve la cuenta a la prueba', () => {
    const result = transition({
      plan: SubscriptionPlan.FREE,
      status: SubscriptionStatus.PAYMENT_PENDING,
      requested: SubscriptionPlan.ANNUAL,
      target: SubscriptionPlan.FREE,
    });

    expect(result.status).toBe(SubscriptionStatus.TRIALING);
    expect(result.requested_plan).toBeNull();
    expect(result.plan_requested_at).toBeNull();
    expect(result.changed).toBe(true);
  });

  it('con un plan pagado, cancela la renovación sin cortar el servicio', () => {
    const result = transition({
      plan: SubscriptionPlan.MONTHLY,
      status: SubscriptionStatus.ACTIVE,
      target: SubscriptionPlan.FREE,
    });

    // `canceled`, no `trialing`: lo que ya pagó corre hasta su fecha. La
    // vigencia (`expires_at`) ni se menciona aquí — esta función no la toca.
    expect(result.status).toBe(SubscriptionStatus.CANCELED);
    expect(result.requested_plan).toBeNull();
    expect(result.changed).toBe(true);
  });

  it('cancelar dos veces no cuenta como cambio', () => {
    const result = transition({
      plan: SubscriptionPlan.MONTHLY,
      status: SubscriptionStatus.CANCELED,
      target: SubscriptionPlan.FREE,
    });

    expect(result.changed).toBe(false);
    expect(result.status).toBe(SubscriptionStatus.CANCELED);
  });

  it('quedarse en la prueba estando en la prueba no cambia nada', () => {
    const result = transition({
      plan: SubscriptionPlan.FREE,
      status: SubscriptionStatus.TRIALING,
      target: SubscriptionPlan.FREE,
    });

    expect(result.changed).toBe(false);
    expect(result.status).toBe(SubscriptionStatus.TRIALING);
    expect(result.requested_plan).toBeNull();
  });

  it('un pago rebotado sobre la prueba se limpia al volver a free', () => {
    const result = transition({
      plan: SubscriptionPlan.FREE,
      status: SubscriptionStatus.PAYMENT_FAILED,
      requested: SubscriptionPlan.MONTHLY,
      target: SubscriptionPlan.FREE,
    });

    expect(result.status).toBe(SubscriptionStatus.TRIALING);
    expect(result.requested_plan).toBeNull();
    expect(result.plan_requested_at).toBeNull();
  });
});
