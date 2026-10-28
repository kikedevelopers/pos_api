import type { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { resolveBillingConfig } from '@/config/billing.config';
import { ApplyWompiTransactionAction } from '@/modules/billing/actions/apply-wompi-transaction.action';
import { CreateCheckoutAction } from '@/modules/billing/actions/create-checkout.action';
import { BillingScheduler } from '@/modules/billing/billing.scheduler';
import {
  SubscriptionPayment,
  SubscriptionPaymentStatus,
} from '@/modules/billing/entities/subscription-payment.entity';
import type { WompiTransaction } from '@/modules/billing/wompi/wompi.types';
import { ChangePlanAction } from '@/modules/portal/actions/change-plan.action';
import {
  Subscription,
  SubscriptionPlan,
} from '@/modules/subscriptions/entities/subscription.entity';
import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';

import {
  cleanupCompany,
  createDisposableCompany,
  insertOwnerUser,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL) — CONTROL DE PLAN.
 *
 * Con un plan de pago vigente no se compra otro encima: el cambio se programa
 * y solo en el último mes se paga el siguiente período, cuyos días van
 * DESPUÉS del corte. El plan cambia cuando ese período empieza. Wompi es de
 * mentira (links y transacciones en memoria); lo demás es Postgres.
 */

const DAY = 24 * 60 * 60 * 1000;

let ds: DataSource | null = null;
let companyId: number;
let ownerId: number;
let subscriptionId: string;
let linkSeq = 0;

const transactions = new Map<string, WompiTransaction>();
const config = resolveBillingConfig({
  WOMPI_PRIVATE_KEY: 'prv_test_E2E',
  WOMPI_EVENTS_SECRET: 'test_events_E2E',
});
const wompi = {
  config,
  assertConfigured: jest.fn(),
  createPaymentLink: jest.fn(() => {
    linkSeq += 1;
    return Promise.resolve({ id: `E2EPC${Date.now()}${linkSeq}` });
  }),
  checkoutUrl: (id: string) => `https://checkout.wompi.co/l/${id}`,
  getTransaction: jest.fn((id: string) => {
    const tx = transactions.get(id);
    return tx ? Promise.resolve(tx) : Promise.reject(new Error(`tx ${id} no existe`));
  }),
};
const alerts = { notify: jest.fn().mockResolvedValue(undefined) };

const db = (): DataSource => ds as DataSource;
const subscriptionsService = (): SubscriptionsService =>
  new SubscriptionsService(db().getRepository(Subscription));

const buildCheckout = (): CreateCheckoutAction =>
  new CreateCheckoutAction(
    wompi as never,
    subscriptionsService(),
    db(),
    db().getRepository(SubscriptionPayment),
  );

const buildApply = (): ApplyWompiTransactionAction =>
  new ApplyWompiTransactionAction(
    wompi as never,
    alerts as never,
    db(),
    db().getRepository(SubscriptionPayment),
  );

const buildChangePlan = (): ChangePlanAction =>
  new ChangePlanAction(subscriptionsService(), db().getRepository(Subscription));

const buildScheduler = (): BillingScheduler =>
  new BillingScheduler(
    buildApply(),
    { getOrThrow: () => ({ ...config, reconcileEnabled: true }) } as unknown as ConfigService,
    db().getRepository(SubscriptionPayment),
  );

/** Deja la suscripción con `plan` vigente hasta `expiresAt` y sin pagos. */
async function setSubscription(plan: SubscriptionPlan, expiresAt: Date): Promise<void> {
  await db().query(`DELETE FROM subscription_payments WHERE subscription_id = $1`, [
    subscriptionId,
  ]);
  await db().query(
    `UPDATE subscriptions
        SET started_at = $2, expires_at = $3, plan = $4::subscription_plan,
            status = CASE WHEN $4::subscription_plan = 'free' THEN 'trialing' ELSE 'active' END::subscription_status,
            requested_plan = NULL, plan_requested_at = NULL,
            scheduled_plan = NULL, plan_scheduled_at = NULL
      WHERE id = $1`,
    [subscriptionId, new Date(expiresAt.getTime() - 300 * DAY), expiresAt, plan],
  );
}

async function loadSubscription(): Promise<Subscription> {
  return db()
    .getRepository(Subscription)
    .findOneOrFail({ where: { id: subscriptionId } });
}

async function loadPaymentByReference(reference: string): Promise<SubscriptionPayment> {
  return db().getRepository(SubscriptionPayment).findOneOrFail({ where: { reference } });
}

/** Wompi aprueba el pago de `reference` y se aplica como lo haría el webhook. */
async function approve(reference: string): Promise<SubscriptionPayment> {
  const payment = await loadPaymentByReference(reference);
  const id = `TX-PC-${payment.id}`;
  transactions.set(id, {
    id,
    status: 'APPROVED',
    amount_in_cents: Number(payment.amount_in_cents),
    currency: 'COP',
    payment_link_id: payment.payment_link_id,
    payment_method_type: 'NEQUI',
    status_message: null,
  });
  await buildApply().execute(id, 'webhook');
  return loadPaymentByReference(reference);
}

const countPayments = async (): Promise<number> =>
  Number(
    (
      await db().query(
        `SELECT count(*)::int AS n FROM subscription_payments WHERE subscription_id = $1`,
        [subscriptionId],
      )
    )[0].n,
  );

beforeAll(async () => {
  ds = await tryInitDataSource();
  if (!ds) {
    return;
  }
  companyId = await createDisposableCompany(ds, '__E2E_BILLING_PLAN_CONTROL__');
  ownerId = await insertOwnerUser(ds, companyId, 'plancontrol');
  await ds.query(
    `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [String(companyId), String(ownerId)],
  );
  const created = await ds.query(
    `INSERT INTO subscriptions (company_id, owner_user_id, started_at, expires_at)
     VALUES ($1, $2, now(), now() + interval '10 days') RETURNING id`,
    [String(companyId), String(ownerId)],
  );
  subscriptionId = String(created[0].id);
});

afterAll(async () => {
  if (!ds) {
    return;
  }
  await cleanupCompany(ds, companyId);
  await ds.destroy();
});

beforeEach(() => {
  alerts.notify.mockClear();
  wompi.createPaymentLink.mockClear();
});

const itDb = (name: string, fn: () => Promise<void>): void =>
  it(name, async () => {
    if (!ds) {
      console.warn(`[e2e plan] sin BD, se omite: ${name}`);
      return;
    }
    await fn();
  });

describe('Control de plan — no se compra un plan encima de otro (BD real)', () => {
  itDb(
    'el caso reportado: anual vigente con 65 días → comprar otro anual da 409 y no suma nada',
    async () => {
      const expires = new Date(Date.now() + 65 * DAY);
      await setSubscription(SubscriptionPlan.ANNUAL, expires);

      const error = await buildCheckout()
        .execute(ownerId, companyId, 'annual')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(
        ((error as ConflictException).getResponse() as { payload: { code: string } }).payload.code,
      ).toBe('RENEWAL_NOT_OPEN');
      expect(wompi.createPaymentLink).not.toHaveBeenCalled();
      expect(await countPayments()).toBe(0);
      const sub = await loadSubscription();
      expect(sub.expires_at.getTime()).toBe(expires.getTime());
      expect(sub.plan).toBe('annual');
      expect(sub.status).toBe('active');
    },
  );

  itDb('tampoco se paga el mensual encima del anual vigente', async () => {
    await setSubscription(SubscriptionPlan.ANNUAL, new Date(Date.now() + 200 * DAY));

    await expect(buildCheckout().execute(ownerId, companyId, 'monthly')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await countPayments()).toBe(0);
  });
});

describe('Control de plan — cambio programado (BD real)', () => {
  itDb(
    'anual con más de un mes: elegir mensual lo PROGRAMA y no toca plan, vigencia ni estado',
    async () => {
      const expires = new Date(Date.now() + 400 * DAY);
      await setSubscription(SubscriptionPlan.ANNUAL, expires);

      const dto = await buildChangePlan().execute(ownerId, companyId, SubscriptionPlan.MONTHLY);

      expect(dto.plan).toBe('annual');
      expect(dto.scheduled_plan).toBe('monthly');
      expect(dto.status).toBe('active');
      expect(dto.can_pay_now).toBe(false);
      expect(new Date(dto.renewal_opens_at as string).getTime()).toBe(expires.getTime() - 30 * DAY);

      const sub = await loadSubscription();
      expect(sub.plan).toBe('annual');
      expect(sub.scheduled_plan).toBe('monthly');
      expect(sub.plan_scheduled_at).not.toBeNull();
      expect(sub.requested_plan).toBeNull();
      expect(sub.expires_at.getTime()).toBe(expires.getTime());
    },
  );

  itDb('volver a elegir el anual retira el cambio programado', async () => {
    await setSubscription(SubscriptionPlan.ANNUAL, new Date(Date.now() + 400 * DAY));
    await buildChangePlan().execute(ownerId, companyId, SubscriptionPlan.MONTHLY);

    const dto = await buildChangePlan().execute(ownerId, companyId, SubscriptionPlan.ANNUAL);

    expect(dto.scheduled_plan).toBeNull();
    expect((await loadSubscription()).scheduled_plan).toBeNull();
  });

  itDb('la BD rechaza programar "free" (volver a gratis es cancelar, no programar)', async () => {
    await expect(
      db().query(`UPDATE subscriptions SET scheduled_plan = 'free' WHERE id = $1`, [
        subscriptionId,
      ]),
    ).rejects.toThrow(/chk_subscriptions_scheduled_plan_paid/);
  });
});

describe('Control de plan — renovación en el último mes (BD real)', () => {
  itDb(
    'anual con 10 días → pagar mensual: los 30 días van DESPUÉS del corte y el anual se respeta hasta ahí',
    async () => {
      const expires = new Date(Date.now() + 10 * DAY);
      await setSubscription(SubscriptionPlan.ANNUAL, expires);

      const checkout = await buildCheckout().execute(ownerId, companyId, 'monthly');
      let sub = await loadSubscription();
      expect(sub.status).toBe('active');
      expect(sub.requested_plan).toBeNull();
      expect(sub.scheduled_plan).toBe('monthly');

      const payment = await approve(checkout.reference);

      expect(payment.status).toBe(SubscriptionPaymentStatus.APPROVED);
      expect(payment.period_starts_at?.getTime()).toBe(expires.getTime());
      expect(payment.period_ends_at?.getTime()).toBe(expires.getTime() + 30 * DAY);
      sub = await loadSubscription();
      expect(sub.plan).toBe('annual');
      expect(sub.status).toBe('active');
      expect(sub.scheduled_plan).toBeNull();
      expect(sub.expires_at.getTime()).toBe(expires.getTime() + 30 * DAY);

      // Ya pagó el siguiente período: la ventana se cerró, no se cobra otra vez.
      await expect(buildCheckout().execute(ownerId, companyId, 'monthly')).rejects.toBeInstanceOf(
        ConflictException,
      );

      // Antes del corte el barrido no cambia nada…
      expect(await buildScheduler().promoteStartedPeriods(new Date())).toBe(0);
      expect((await loadSubscription()).plan).toBe('annual');

      // …y al empezar el período pagado, pasa a mensual (una sola vez).
      const afterCut = new Date(expires.getTime() + 60 * 60 * 1000);
      expect(await buildScheduler().promoteStartedPeriods(afterCut)).toBe(1);
      expect((await loadSubscription()).plan).toBe('monthly');
      expect(await buildScheduler().promoteStartedPeriods(afterCut)).toBe(0);
    },
  );

  itDb(
    'renovar el MISMO plan en el último mes suma los días y no marca nada pendiente',
    async () => {
      const expires = new Date(Date.now() + 5 * DAY);
      await setSubscription(SubscriptionPlan.MONTHLY, expires);

      const checkout = await buildCheckout().execute(ownerId, companyId, 'monthly');
      expect((await loadSubscription()).status).toBe('active');
      await approve(checkout.reference);

      const sub = await loadSubscription();
      expect(sub.plan).toBe('monthly');
      expect(sub.expires_at.getTime()).toBe(expires.getTime() + 30 * DAY);
    },
  );

  itDb(
    'desde la prueba gratis el plan pagado aplica YA y conserva los días de prueba',
    async () => {
      const expires = new Date(Date.now() + 5 * DAY);
      await setSubscription(SubscriptionPlan.FREE, expires);

      const checkout = await buildCheckout().execute(ownerId, companyId, 'annual');
      expect((await loadSubscription()).status).toBe('payment_pending');
      await approve(checkout.reference);

      const sub = await loadSubscription();
      expect(sub.plan).toBe('annual');
      expect(sub.status).toBe('active');
      expect(sub.expires_at.getTime()).toBe(expires.getTime() + 365 * DAY);
    },
  );

  itDb('con el plan vencido, el pago arranca hoy y el plan cambia de inmediato', async () => {
    await setSubscription(SubscriptionPlan.ANNUAL, new Date(Date.now() - 3 * DAY));

    const before = Date.now();
    const checkout = await buildCheckout().execute(ownerId, companyId, 'monthly');
    await approve(checkout.reference);

    const sub = await loadSubscription();
    expect(sub.plan).toBe('monthly');
    expect(sub.expires_at.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(sub.expires_at.getTime()).toBeLessThan(before + 31 * DAY);
  });

  itDb(
    'si pagó, se carga: un link abierto en la ventana y pagado DESPUÉS de cerrarla se aplica igual',
    async () => {
      const expires = new Date(Date.now() + 10 * DAY);
      await setSubscription(SubscriptionPlan.ANNUAL, expires);
      const first = await buildCheckout().execute(ownerId, companyId, 'monthly');
      const second = await buildCheckout().execute(ownerId, companyId, 'annual');

      await approve(second.reference);
      const late = await approve(first.reference);

      expect(late.status).toBe(SubscriptionPaymentStatus.APPROVED);
      const sub = await loadSubscription();
      expect(sub.expires_at.getTime()).toBe(expires.getTime() + 365 * DAY + 30 * DAY);
      expect(sub.plan).toBe('annual');
    },
  );
});
