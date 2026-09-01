import { ForbiddenException, NotFoundException } from '@nestjs/common';

import {
  SubscriptionPlan,
  SubscriptionStatus,
} from '@/modules/subscriptions/entities/subscription.entity';

import { ChangePlanAction } from '../change-plan.action';

// ---------------------------------------------------------------------------
// El endpoint que cambia el plan.
//
// Lo que se vigila: que nunca escriba `plan` ni `expires_at`. Ese es el límite
// entre "pedí el anual" y "tengo el anual gratis", y tiene que sostenerse
// aunque mañana alguien añada un caso nuevo.
// ---------------------------------------------------------------------------

const OWNER_ID = 7;
const COMPANY_ID = 42;

const baseSubscription = {
  id: '1',
  company_id: String(COMPANY_ID),
  owner_user_id: String(OWNER_ID),
  started_at: new Date('2026-08-05T12:00:00.000Z'),
  expires_at: new Date('2026-08-15T12:00:00.000Z'),
  plan: SubscriptionPlan.FREE,
  status: SubscriptionStatus.TRIALING,
  requested_plan: null as SubscriptionPlan | null,
  plan_requested_at: null as Date | null,
};

function build(overrides: Partial<typeof baseSubscription> | null = {}): {
  action: ChangePlanAction;
  repo: { update: jest.Mock };
  subscriptionsService: { findApplicable: jest.Mock };
} {
  const subscription = overrides === null ? null : { ...baseSubscription, ...overrides };
  const subscriptionsService = { findApplicable: jest.fn().mockResolvedValue(subscription) };
  const repo = { update: jest.fn().mockResolvedValue(undefined) };
  const action = new ChangePlanAction(subscriptionsService as never, repo as never);
  return { action, repo, subscriptionsService };
}

describe('pedir un plan de pago', () => {
  it('guarda la solicitud y deja el cobro pendiente', async () => {
    const { action, repo } = build();

    const result = await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.ANNUAL);

    expect(repo.update).toHaveBeenCalledWith('1', {
      status: SubscriptionStatus.PAYMENT_PENDING,
      requested_plan: SubscriptionPlan.ANNUAL,
      plan_requested_at: expect.any(Date) as Date,
    });
    expect(result.requested_plan).toBe(SubscriptionPlan.ANNUAL);
    expect(result.plan).toBe(SubscriptionPlan.FREE);
  });

  it('NUNCA escribe el plan ni la fecha de vencimiento', async () => {
    const { action, repo } = build();

    await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.ANNUAL);

    const [, written] = repo.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(written).not.toHaveProperty('plan');
    expect(written).not.toHaveProperty('expires_at');
    expect(written).not.toHaveProperty('started_at');
  });

  it('la respuesta ya trae el estado cruzado con la vigencia', async () => {
    // Suscripción vencida + solicitud sin pagar → el portal debe poder decir
    // "está vencida porque el pago no se ha procesado", no un "vencida" seco.
    const { action } = build({ expires_at: new Date('2020-01-01T00:00:00.000Z') });

    const result = await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.MONTHLY);

    expect(result.is_expired).toBe(true);
    expect(result.status).toBe('payment_pending');
  });
});

describe('volver a free', () => {
  it('retira la solicitud pendiente', async () => {
    const { action, repo } = build({
      status: SubscriptionStatus.PAYMENT_PENDING,
      requested_plan: SubscriptionPlan.ANNUAL,
      plan_requested_at: new Date('2026-08-14T12:00:00.000Z'),
    });

    const result = await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.FREE);

    expect(repo.update).toHaveBeenCalledWith('1', {
      status: SubscriptionStatus.TRIALING,
      requested_plan: null,
      plan_requested_at: null,
    });
    expect(result.requested_plan).toBeNull();
  });

  it('con un plan pagado cancela la renovación y respeta lo ya pagado', async () => {
    const { action, repo } = build({
      plan: SubscriptionPlan.MONTHLY,
      status: SubscriptionStatus.ACTIVE,
      expires_at: new Date('2099-01-01T00:00:00.000Z'),
    });

    const result = await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.FREE);

    expect(repo.update).toHaveBeenCalledWith('1', {
      status: SubscriptionStatus.CANCELED,
      requested_plan: null,
      plan_requested_at: null,
    });
    // Sigue siendo mensual y sigue vigente: canceló, no se le quitó nada.
    expect(result.plan).toBe(SubscriptionPlan.MONTHLY);
    expect(result.is_expired).toBe(false);
  });
});

describe('quién puede cambiarlo', () => {
  it('un usuario que no es el titular no cambia nada', async () => {
    const { action, repo } = build();

    const error = await action
      .execute(999, COMPANY_ID, SubscriptionPlan.ANNUAL)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('sin suscripción responde 404 en vez de crear una', async () => {
    const { action, repo } = build(null);

    await expect(
      action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.ANNUAL),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('la suscripción se busca por la company del token, no por una del cliente', async () => {
    const { action, subscriptionsService } = build();

    await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.ANNUAL);

    expect(subscriptionsService.findApplicable).toHaveBeenCalledWith(COMPANY_ID);
  });
});
