import { NotFoundException } from '@nestjs/common';

import { SubscriptionPaymentStatus } from '@/modules/billing/entities/subscription-payment.entity';
import {
  SubscriptionPlan,
  SubscriptionStatus,
} from '@/modules/subscriptions/entities/subscription.entity';

import { GetPortalAccountAction } from '../get-portal-account.action';

// ---------------------------------------------------------------------------
// La cuenta del portal: además de la suscripción, el período YA PAGADO que
// todavía no empieza (renovación anticipada con cambio de plan).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

const subscription = {
  id: '1',
  company_id: '42',
  owner_user_id: '7',
  started_at: new Date(now - 300 * DAY),
  expires_at: new Date(now + 40 * DAY),
  plan: SubscriptionPlan.ANNUAL,
  status: SubscriptionStatus.ACTIVE,
  requested_plan: null,
  plan_requested_at: null,
  scheduled_plan: null,
  plan_scheduled_at: null,
};

function build(opts: { upcoming?: object | null; sub?: object | null } = {}) {
  const usersService = {
    findById: jest.fn().mockResolvedValue({
      id: '7',
      name: 'Kike',
      lastname: 'P',
      email: 'k@x.co',
      created_at: new Date(),
    }),
  };
  const subscriptionsService = {
    findApplicable: jest.fn().mockResolvedValue(opts.sub === undefined ? subscription : opts.sub),
  };
  const companiesRepo = {
    findOne: jest.fn().mockResolvedValue({
      id: '42',
      name: 'Esencia',
      document_number: null,
      phone_number: null,
      created_at: new Date(),
    }),
  };
  const membersRepo = {
    createQueryBuilder: () => {
      const qb = {
        innerJoin: () => qb,
        where: () => qb,
        andWhere: () => qb,
        getCount: () => Promise.resolve(0),
      };
      return qb;
    },
  };
  const paymentsRepo = { findOne: jest.fn().mockResolvedValue(opts.upcoming ?? null) };
  const action = new GetPortalAccountAction(
    usersService as never,
    subscriptionsService as never,
    companiesRepo as never,
    membersRepo as never,
    paymentsRepo as never,
  );
  return { action, paymentsRepo };
}

describe('GetPortalAccountAction · período ya pagado por empezar', () => {
  it('devuelve el siguiente período aprobado que aún no empieza', async () => {
    const starts = new Date(now + 40 * DAY);
    const ends = new Date(now + 70 * DAY);
    const { action, paymentsRepo } = build({
      upcoming: { plan: SubscriptionPlan.MONTHLY, period_starts_at: starts, period_ends_at: ends },
    });

    const account = await action.execute(7, 42);

    expect(account.upcoming_period).toEqual({
      plan: 'monthly',
      starts_at: starts.toISOString(),
      ends_at: ends.toISOString(),
    });
    const [query] = paymentsRepo.findOne.mock.calls[0] as [
      { where: Record<string, unknown>; order: Record<string, string> },
    ];
    // Solo pagos APROBADOS de ESTA suscripción, el más próximo primero.
    expect(query.where.subscription_id).toBe('1');
    expect(query.where.status).toBe(SubscriptionPaymentStatus.APPROVED);
    expect(query.order).toEqual({ period_starts_at: 'ASC' });
  });

  it('sin período por empezar responde null', async () => {
    const { action } = build();

    const account = await action.execute(7, 42);

    expect(account.upcoming_period).toBeNull();
    expect(account.subscription?.plan).toBe('annual');
  });

  it('sin suscripción no consulta pagos', async () => {
    const { action, paymentsRepo } = build({ sub: null });

    const account = await action.execute(7, 42);

    expect(account.subscription).toBeNull();
    expect(account.upcoming_period).toBeNull();
    expect(paymentsRepo.findOne).not.toHaveBeenCalled();
  });

  it('usuario inexistente → 404', async () => {
    const { action } = build();
    (
      action as unknown as { usersService: { findById: jest.Mock } }
    ).usersService.findById.mockResolvedValue(null);

    await expect(action.execute(7, 42)).rejects.toBeInstanceOf(NotFoundException);
  });
});
