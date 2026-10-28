import { SubscriptionPlan } from '@/modules/subscriptions/entities/subscription.entity';

import { PAID_PLAN_TERMS, termsForPlan } from '../billing.constants';

describe('billing.constants — lo que se cobra', () => {
  it('el monto a Wompi es exactamente el precio × 100 (centavos)', () => {
    for (const terms of Object.values(PAID_PLAN_TERMS)) {
      expect(terms.amount_in_cents).toBe(terms.price_cop * 100);
      expect(Number.isSafeInteger(terms.amount_in_cents)).toBe(true);
    }
  });

  it('precios publicados en la landing: mensual $50.000 / 30 días, anual $400.000 / 365 días', () => {
    expect(termsForPlan('monthly')).toMatchObject({ price_cop: 50_000, days: 30 });
    expect(termsForPlan('annual')).toMatchObject({ price_cop: 400_000, days: 365 });
  });

  it('free y planes inexistentes no se cobran', () => {
    expect(termsForPlan(SubscriptionPlan.FREE)).toBeNull();
    expect(termsForPlan('gold')).toBeNull();
    expect(termsForPlan('__proto__')).toBeNull();
    expect(termsForPlan('toString')).toBeNull();
  });
});
