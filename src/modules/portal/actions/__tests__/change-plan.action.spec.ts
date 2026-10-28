import { ForbiddenException, NotFoundException } from '@nestjs/common';

import {
  Subscription,
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
  scheduled_plan: null as SubscriptionPlan | null,
  plan_scheduled_at: null as Date | null,
};

function build(overrides: Partial<typeof baseSubscription> | null = {}): {
  action: ChangePlanAction;
  manager: { update: jest.Mock };
  lock: jest.Mock;
  subscriptionsService: { findApplicable: jest.Mock };
} {
  const subscription = overrides === null ? null : { ...baseSubscription, ...overrides };
  const subscriptionsService = { findApplicable: jest.fn().mockResolvedValue(subscription) };
  // La fila se relee BAJO BLOQUEO dentro de la transacción.
  const lock = jest.fn();
  const queryBuilder = {
    setLock: (mode: string) => {
      lock(mode);
      return queryBuilder;
    },
    where: () => queryBuilder,
    getOneOrFail: () => Promise.resolve(subscription),
  };
  const manager = {
    update: jest.fn().mockResolvedValue(undefined),
    getRepository: () => ({ createQueryBuilder: () => queryBuilder }),
  };
  const repo = {
    manager: {
      transaction: (work: (m: typeof manager) => Promise<unknown>) => work(manager),
    },
  };
  const action = new ChangePlanAction(subscriptionsService as never, repo as never);
  return { action, manager, lock, subscriptionsService };
}

describe('pedir un plan de pago', () => {
  it('guarda la solicitud y deja el cobro pendiente', async () => {
    const { action, manager } = build();

    const result = await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.ANNUAL);

    expect(manager.update).toHaveBeenCalledWith(Subscription, '1', {
      status: SubscriptionStatus.PAYMENT_PENDING,
      requested_plan: SubscriptionPlan.ANNUAL,
      plan_requested_at: expect.any(Date) as Date,
      scheduled_plan: null,
      plan_scheduled_at: null,
    });
    expect(result.requested_plan).toBe(SubscriptionPlan.ANNUAL);
    expect(result.plan).toBe(SubscriptionPlan.FREE);
  });

  it('NUNCA escribe el plan ni la fecha de vencimiento', async () => {
    const { action, manager } = build();

    await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.ANNUAL);

    const [, , written] = manager.update.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
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

describe('con un plan de pago vigente', () => {
  const annualRunning = {
    plan: SubscriptionPlan.ANNUAL,
    status: SubscriptionStatus.ACTIVE,
    expires_at: new Date('2099-01-01T00:00:00.000Z'),
  };

  it('elegir otro plan lo PROGRAMA para el corte, sin pago pendiente', async () => {
    const { action, manager, lock } = build(annualRunning);

    const result = await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.MONTHLY);

    expect(lock).toHaveBeenCalledWith('pessimistic_write');
    expect(manager.update).toHaveBeenCalledWith(Subscription, '1', {
      status: SubscriptionStatus.ACTIVE,
      requested_plan: null,
      plan_requested_at: null,
      scheduled_plan: SubscriptionPlan.MONTHLY,
      plan_scheduled_at: expect.any(Date) as Date,
    });
    // Sigue en el anual pagado; el mensual arranca al corte.
    expect(result.plan).toBe(SubscriptionPlan.ANNUAL);
    expect(result.scheduled_plan).toBe(SubscriptionPlan.MONTHLY);
    expect(result.status).toBe('active');
    expect(result.can_pay_now).toBe(false);
    expect(result.renewal_opens_at).not.toBeNull();
  });

  it('volver a elegir el plan actual retira el cambio programado', async () => {
    const { action, manager } = build({
      ...annualRunning,
      scheduled_plan: SubscriptionPlan.MONTHLY,
      plan_scheduled_at: new Date('2026-08-10T00:00:00.000Z'),
    });

    const result = await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.ANNUAL);

    const [, , written] = manager.update.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(written.scheduled_plan).toBeNull();
    expect(written).not.toHaveProperty('plan');
    expect(written).not.toHaveProperty('expires_at');
    expect(result.scheduled_plan).toBeNull();
  });
});

describe('volver a free', () => {
  it('retira la solicitud pendiente', async () => {
    const { action, manager } = build({
      status: SubscriptionStatus.PAYMENT_PENDING,
      requested_plan: SubscriptionPlan.ANNUAL,
      plan_requested_at: new Date('2026-08-14T12:00:00.000Z'),
    });

    const result = await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.FREE);

    expect(manager.update).toHaveBeenCalledWith(Subscription, '1', {
      status: SubscriptionStatus.TRIALING,
      requested_plan: null,
      plan_requested_at: null,
      scheduled_plan: null,
      plan_scheduled_at: null,
    });
    expect(result.requested_plan).toBeNull();
  });

  it('con un plan pagado cancela la renovación y respeta lo ya pagado', async () => {
    const { action, manager } = build({
      plan: SubscriptionPlan.MONTHLY,
      status: SubscriptionStatus.ACTIVE,
      expires_at: new Date('2099-01-01T00:00:00.000Z'),
    });

    const result = await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.FREE);

    expect(manager.update).toHaveBeenCalledWith(Subscription, '1', {
      status: SubscriptionStatus.CANCELED,
      requested_plan: null,
      plan_requested_at: null,
      scheduled_plan: null,
      plan_scheduled_at: null,
    });
    // Sigue siendo mensual y sigue vigente: canceló, no se le quitó nada.
    expect(result.plan).toBe(SubscriptionPlan.MONTHLY);
    expect(result.is_expired).toBe(false);
  });
});

describe('quién puede cambiarlo', () => {
  it('un usuario que no es el titular no cambia nada', async () => {
    const { action, manager } = build();

    const error = await action
      .execute(999, COMPANY_ID, SubscriptionPlan.ANNUAL)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('sin suscripción responde 404 en vez de crear una', async () => {
    const { action, manager } = build(null);

    await expect(
      action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.ANNUAL),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('la suscripción se busca por la company del token, no por una del cliente', async () => {
    const { action, subscriptionsService } = build();

    await action.execute(OWNER_ID, COMPANY_ID, SubscriptionPlan.ANNUAL);

    expect(subscriptionsService.findApplicable).toHaveBeenCalledWith(COMPANY_ID);
  });
});
