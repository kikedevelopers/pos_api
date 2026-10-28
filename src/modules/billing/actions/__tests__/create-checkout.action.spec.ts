import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { resolveBillingConfig } from '@/config/billing.config';
import {
  SubscriptionPlan,
  SubscriptionStatus,
} from '@/modules/subscriptions/entities/subscription.entity';

import { SubscriptionPaymentStatus } from '../../entities/subscription-payment.entity';
import { WompiApiError } from '../../wompi/wompi.client';
import { CreateCheckoutAction } from '../create-checkout.action';

const OWNER = 7;
const COMPANY = 42;
const subscription = {
  id: '1',
  company_id: String(COMPANY),
  owner_user_id: String(OWNER),
  plan: SubscriptionPlan.FREE,
  status: SubscriptionStatus.TRIALING,
  requested_plan: null,
  expires_at: new Date('2026-11-01T00:00:00.000Z'),
};

function build(
  opts: {
    reusable?: object | null;
    sub?: object | null;
    /** La fila tal como se lee BAJO BLOQUEO (por defecto, la misma). */
    locked?: object;
    configured?: boolean;
  } = {},
) {
  const config = resolveBillingConfig(
    opts.configured === false
      ? {}
      : { WOMPI_PRIVATE_KEY: 'prv_test_K', WOMPI_EVENTS_SECRET: 'test_events_S' },
  );
  const wompi = {
    config,
    assertConfigured: jest.fn(() => {
      if (!config.configured) {
        throw new ServiceUnavailableException();
      }
    }),
    createPaymentLink: jest.fn().mockResolvedValue({ id: 'LINK1' }),
    checkoutUrl: (id: string) => `https://checkout.wompi.co/l/${id}`,
  };
  const subscriptionsService = {
    findApplicable: jest.fn().mockResolvedValue(opts.sub === undefined ? subscription : opts.sub),
  };
  const manager = {
    getRepository: () => ({
      createQueryBuilder: () => ({
        setLock: function () {
          return this;
        },
        where: function () {
          return this;
        },
        getOneOrFail: () =>
          Promise.resolve({ ...(opts.locked ?? (opts.sub as object | undefined) ?? subscription) }),
      }),
    }),
    update: jest.fn().mockResolvedValue(undefined),
    create: jest.fn((_e: unknown, data: object) => data),
    save: jest.fn((_e: unknown, data: object) =>
      Promise.resolve({ id: '9', created_at: new Date(), ...data }),
    ),
  };
  const dataSource = { transaction: jest.fn((fn: (m: typeof manager) => unknown) => fn(manager)) };
  const repo = { findOne: jest.fn().mockResolvedValue(opts.reusable ?? null) };
  const action = new CreateCheckoutAction(
    wompi as never,
    subscriptionsService as never,
    dataSource as never,
    repo as never,
  );
  return { action, wompi, manager, repo, dataSource };
}

describe('CreateCheckoutAction', () => {
  it('crea el link con el monto DEL SERVIDOR y deja la suscripción pendiente del plan', async () => {
    const { action, wompi, manager } = build();
    const result = await action.execute(OWNER, COMPANY, 'annual');

    expect(wompi.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ amount_in_cents: 40_000_000, currency: 'COP' }),
    );
    const redirect = wompi.createPaymentLink.mock.calls[0][0].redirect_url as string;
    expect(redirect).toMatch(/\/panel\/pago\?ref=[0-9a-f-]{36}$/);
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      '1',
      expect.objectContaining({
        status: SubscriptionStatus.PAYMENT_PENDING,
        requested_plan: SubscriptionPlan.ANNUAL,
      }),
    );
    expect(result).toMatchObject({
      plan: 'annual',
      amount_in_cents: 40_000_000,
      days_granted: 365,
      status: 'pending',
      checkout_url: 'https://checkout.wompi.co/l/LINK1',
    });
  });

  it('reutiliza el link pendiente del mismo plan (varios clics ≠ varios cobros)', async () => {
    const reusable = {
      reference: 'r',
      plan: 'monthly',
      amount_in_cents: '5000000',
      currency: 'COP',
      days_granted: 30,
      status: SubscriptionPaymentStatus.PENDING,
      checkout_url: 'https://checkout.wompi.co/l/OLD',
      link_expires_at: new Date('2026-12-01T00:00:00.000Z'),
      provider_transaction_id: null,
      payment_method_type: null,
      failure_reason: null,
      applied_at: null,
      period_ends_at: null,
      created_at: new Date(),
    };
    const { action, wompi } = build({ reusable });
    const result = await action.execute(OWNER, COMPANY, 'monthly');
    expect(result.checkout_url).toBe('https://checkout.wompi.co/l/OLD');
    expect(wompi.createPaymentLink).not.toHaveBeenCalled();
  });

  it('plan free o inexistente → 400 sin tocar Wompi', async () => {
    const { action, wompi } = build();
    await expect(action.execute(OWNER, COMPANY, 'free')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(action.execute(OWNER, COMPANY, 'gold')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(wompi.createPaymentLink).not.toHaveBeenCalled();
  });

  it('quien no es el titular → 403', async () => {
    const { action, wompi } = build();
    await expect(action.execute(999, COMPANY, 'monthly')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(wompi.createPaymentLink).not.toHaveBeenCalled();
  });

  it('sin suscripción → 404', async () => {
    const { action } = build({ sub: null });
    await expect(action.execute(OWNER, COMPANY, 'monthly')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('pasarela sin configurar → 503', async () => {
    const { action } = build({ configured: false });
    await expect(action.execute(OWNER, COMPANY, 'monthly')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('Wompi falla al crear el link → 502 legible y NO se registra ningún pago', async () => {
    const { action, wompi, dataSource } = build();
    wompi.createPaymentLink.mockRejectedValue(new WompiApiError('boom', 500));
    await expect(action.execute(OWNER, COMPANY, 'monthly')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});

describe('CreateCheckoutAction · control de plan', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const annualWith = (days: number) => ({
    ...subscription,
    plan: SubscriptionPlan.ANNUAL,
    status: SubscriptionStatus.ACTIVE,
    expires_at: new Date(Date.now() + days * DAY),
  });

  it('con un plan anual vigente y más de un mes por delante → 409 RENEWAL_NOT_OPEN, sin tocar Wompi', async () => {
    const { action, wompi, repo, dataSource } = build({ sub: annualWith(400) });

    const error = (await action
      .execute(OWNER, COMPANY, 'annual')
      .catch((e: unknown) => e)) as ConflictException;

    expect(error).toBeInstanceOf(ConflictException);
    const body = error.getResponse() as { message: string; payload: Record<string, string> };
    expect(body.payload.code).toBe('RENEWAL_NOT_OPEN');
    expect(new Date(body.payload.renewal_opens_at).getTime()).toBeCloseTo(
      Date.now() + 370 * DAY,
      -5,
    );
    expect(body.message).toContain('Anual');
    expect(wompi.createPaymentLink).not.toHaveBeenCalled();
    // Ni siquiera reutiliza un link viejo: no hay nada que pagar todavía.
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('tampoco deja comprar OTRO plan encima del vigente', async () => {
    const { action, wompi } = build({ sub: annualWith(200) });

    await expect(action.execute(OWNER, COMPANY, 'monthly')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(wompi.createPaymentLink).not.toHaveBeenCalled();
  });

  it('en el último mes, pagar OTRO plan es la renovación: queda programado y la suscripción sigue activa', async () => {
    const { action, wompi, manager } = build({ sub: annualWith(10) });

    const result = await action.execute(OWNER, COMPANY, 'monthly');

    expect(wompi.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ amount_in_cents: 5_000_000 }),
    );
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      '1',
      expect.objectContaining({
        status: SubscriptionStatus.ACTIVE,
        requested_plan: null,
        scheduled_plan: SubscriptionPlan.MONTHLY,
      }),
    );
    expect(result).toMatchObject({ plan: 'monthly', days_granted: 30, status: 'pending' });
  });

  it('en el último mes, renovar el MISMO plan no marca nada pendiente', async () => {
    const { action, manager } = build({ sub: annualWith(10) });

    await action.execute(OWNER, COMPANY, 'annual');

    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.save).toHaveBeenCalled();
  });

  it('si al bloquear la fila la ventana ya se cerró (otro pago se aplicó) → 409 y no se registra el pago', async () => {
    const { action, manager } = build({ sub: annualWith(10), locked: annualWith(40) });

    await expect(action.execute(OWNER, COMPANY, 'annual')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('con el plan vencido se paga de inmediato (queda pendiente del plan pedido)', async () => {
    const { action, manager } = build({ sub: annualWith(-5) });

    await action.execute(OWNER, COMPANY, 'monthly');

    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      '1',
      expect.objectContaining({
        status: SubscriptionStatus.PAYMENT_PENDING,
        requested_plan: SubscriptionPlan.MONTHLY,
      }),
    );
  });
});
