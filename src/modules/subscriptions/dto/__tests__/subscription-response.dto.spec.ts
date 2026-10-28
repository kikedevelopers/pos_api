import {
  type Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
} from '../../entities/subscription.entity';
import { toSubscriptionResponseDto } from '../subscription-response.dto';

// ---------------------------------------------------------------------------
// Los campos de control de plan que el portal usa para decidir qué botón
// mostrar: si se puede pagar ya, desde cuándo, y qué cambio hay programado.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-28T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const sub = (overrides: Partial<Subscription>): Subscription =>
  ({
    id: '1',
    company_id: '42',
    owner_user_id: '7',
    started_at: new Date(NOW.getTime() - 100 * DAY),
    expires_at: new Date(NOW.getTime() + 10 * DAY),
    plan: SubscriptionPlan.FREE,
    status: SubscriptionStatus.TRIALING,
    requested_plan: null,
    plan_requested_at: null,
    scheduled_plan: null,
    plan_scheduled_at: null,
    ...overrides,
  }) as Subscription;

describe('toSubscriptionResponseDto · control de plan', () => {
  it('anual vigente con más de un mes: no se puede pagar y dice desde cuándo', () => {
    const expires = new Date(NOW.getTime() + 400 * DAY);
    const dto = toSubscriptionResponseDto(
      sub({
        plan: SubscriptionPlan.ANNUAL,
        status: SubscriptionStatus.ACTIVE,
        expires_at: expires,
        scheduled_plan: SubscriptionPlan.MONTHLY,
        plan_scheduled_at: NOW,
      }),
      NOW,
    );

    expect(dto.can_pay_now).toBe(false);
    expect(dto.renewal_opens_at).toBe(new Date(expires.getTime() - 30 * DAY).toISOString());
    expect(dto.scheduled_plan).toBe('monthly');
    expect(dto.plan_scheduled_at).toBe(NOW.toISOString());
  });

  it('en el último mes se puede pagar la renovación', () => {
    const dto = toSubscriptionResponseDto(
      sub({ plan: SubscriptionPlan.MONTHLY, status: SubscriptionStatus.ACTIVE }),
      NOW,
    );

    expect(dto.can_pay_now).toBe(true);
    expect(dto.renewal_opens_at).not.toBeNull();
  });

  it('en la prueba gratis se puede pagar ya y no hay ventana de renovación', () => {
    const dto = toSubscriptionResponseDto(sub({}), NOW);

    expect(dto.can_pay_now).toBe(true);
    expect(dto.renewal_opens_at).toBeNull();
    expect(dto.scheduled_plan).toBeNull();
  });

  it('con el plan de pago vencido se puede pagar ya', () => {
    const dto = toSubscriptionResponseDto(
      sub({
        plan: SubscriptionPlan.ANNUAL,
        status: SubscriptionStatus.ACTIVE,
        expires_at: new Date(NOW.getTime() - DAY),
      }),
      NOW,
    );

    expect(dto.can_pay_now).toBe(true);
    expect(dto.renewal_opens_at).toBeNull();
    expect(dto.status).toBe('expired');
  });

  it('una fila sin las columnas nuevas (undefined) responde null, no undefined', () => {
    const legacy = sub({});
    delete (legacy as Partial<Subscription>).scheduled_plan;
    delete (legacy as Partial<Subscription>).plan_scheduled_at;

    const dto = toSubscriptionResponseDto(legacy, NOW);

    expect(dto.scheduled_plan).toBeNull();
    expect(dto.plan_scheduled_at).toBeNull();
  });
});
