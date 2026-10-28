import { SubscriptionPlan } from '../../entities/subscription.entity';
import { addDays } from '../../subscriptions.constants';
import {
  RENEWAL_WINDOW_DAYS,
  hasRunningPaidPeriod,
  planSwitchesNow,
  renewalOpensAt,
  resolveCheckoutDecision,
} from '../plan-policy';

// ---------------------------------------------------------------------------
// Control de plan: con un plan de pago vigente no se compra otro encima. Solo
// en el último mes se puede pagar el siguiente período (renovación).
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-28T12:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number): Date => new Date(NOW.getTime() + days * MS_PER_DAY);

describe('hasRunningPaidPeriod', () => {
  it('un plan de pago con días por delante está vigente', () => {
    expect(
      hasRunningPaidPeriod({ plan: SubscriptionPlan.ANNUAL, expires_at: inDays(10), now: NOW }),
    ).toBe(true);
  });

  it('la prueba gratis no cuenta como período pagado', () => {
    expect(
      hasRunningPaidPeriod({ plan: SubscriptionPlan.FREE, expires_at: inDays(10), now: NOW }),
    ).toBe(false);
  });

  it('un plan de pago vencido (o que vence justo ahora) ya no está vigente', () => {
    expect(
      hasRunningPaidPeriod({ plan: SubscriptionPlan.MONTHLY, expires_at: inDays(-1), now: NOW }),
    ).toBe(false);
    expect(
      hasRunningPaidPeriod({ plan: SubscriptionPlan.MONTHLY, expires_at: NOW, now: NOW }),
    ).toBe(false);
  });
});

describe('renewalOpensAt', () => {
  it('abre la renovación un mes (30 días) antes del corte', () => {
    expect(RENEWAL_WINDOW_DAYS).toBe(30);
    const expires = new Date('2027-12-31T05:00:00.000Z');
    expect(renewalOpensAt(expires)).toEqual(addDays(expires, -30));
  });
});

describe('resolveCheckoutDecision', () => {
  it('con un plan de pago y MÁS de un mes por delante, NO se cobra', () => {
    const decision = resolveCheckoutDecision({
      plan: SubscriptionPlan.ANNUAL,
      expires_at: inDays(400),
      now: NOW,
    });

    expect(decision).toEqual({
      allowed: false,
      code: 'RENEWAL_NOT_OPEN',
      renewal_opens_at: inDays(370),
      period_ends_at: inDays(400),
    });
  });

  it('con EXACTAMENTE un mes por delante todavía no se cobra', () => {
    const decision = resolveCheckoutDecision({
      plan: SubscriptionPlan.MONTHLY,
      expires_at: inDays(30),
      now: NOW,
    });

    expect(decision.allowed).toBe(false);
  });

  it('con menos de un mes por delante se abre la renovación (el plan cambia al corte)', () => {
    const decision = resolveCheckoutDecision({
      plan: SubscriptionPlan.ANNUAL,
      expires_at: new Date(inDays(30).getTime() - 1),
      now: NOW,
    });

    expect(decision).toEqual({ allowed: true, plan_switch: 'at_period_end' });
  });

  it('en la prueba gratis se paga y aplica ya', () => {
    expect(
      resolveCheckoutDecision({ plan: SubscriptionPlan.FREE, expires_at: inDays(8), now: NOW }),
    ).toEqual({ allowed: true, plan_switch: 'now' });
  });

  it('con el plan de pago vencido se paga y aplica ya', () => {
    expect(
      resolveCheckoutDecision({ plan: SubscriptionPlan.ANNUAL, expires_at: inDays(-3), now: NOW }),
    ).toEqual({ allowed: true, plan_switch: 'now' });
  });
});

describe('planSwitchesNow', () => {
  it('renovar el mismo plan no espera a nada', () => {
    expect(
      planSwitchesNow({
        plan: SubscriptionPlan.MONTHLY,
        expires_at: inDays(10),
        now: NOW,
        paid_plan: SubscriptionPlan.MONTHLY,
      }),
    ).toBe(true);
  });

  it('pagar OTRO plan con un período pagado vigente espera al corte', () => {
    expect(
      planSwitchesNow({
        plan: SubscriptionPlan.ANNUAL,
        expires_at: inDays(10),
        now: NOW,
        paid_plan: SubscriptionPlan.MONTHLY,
      }),
    ).toBe(false);
  });

  it('desde la prueba gratis el plan pagado aplica ya', () => {
    expect(
      planSwitchesNow({
        plan: SubscriptionPlan.FREE,
        expires_at: inDays(5),
        now: NOW,
        paid_plan: SubscriptionPlan.ANNUAL,
      }),
    ).toBe(true);
  });

  it('con el plan anterior vencido el plan pagado aplica ya', () => {
    expect(
      planSwitchesNow({
        plan: SubscriptionPlan.ANNUAL,
        expires_at: inDays(-1),
        now: NOW,
        paid_plan: SubscriptionPlan.MONTHLY,
      }),
    ).toBe(true);
  });
});
