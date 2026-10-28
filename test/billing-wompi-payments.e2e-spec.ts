import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

import { resolveBillingConfig } from '@/config/billing.config';
import { ApplyWompiTransactionAction } from '@/modules/billing/actions/apply-wompi-transaction.action';
import { ConfirmPaymentAction } from '@/modules/billing/actions/confirm-payment.action';
import { BillingScheduler } from '@/modules/billing/billing.scheduler';
import {
  SubscriptionPayment,
  SubscriptionPaymentStatus,
} from '@/modules/billing/entities/subscription-payment.entity';
import type { WompiTransaction } from '@/modules/billing/wompi/wompi.types';
import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';
import { Subscription } from '@/modules/subscriptions/entities/subscription.entity';

import {
  cleanupCompany,
  createDisposableCompany,
  insertOwnerUser,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL) — COBRO DE LA SUSCRIPCIÓN CON WOMPI.
 *
 * La regla innegociable: si el cliente pagó, los días se cargan; si no pagó, no
 * se carga nada; y nunca se cargan dos veces. Eso depende de bloqueos `FOR
 * UPDATE`, de la transacción SQL y de los CHECK de la tabla, que un unitario
 * con mocks no ejercita. Aquí solo Wompi es de mentira (un mapa de
 * transacciones); todo lo demás es Postgres.
 */

const DAY = 24 * 60 * 60 * 1000;

let ds: DataSource | null = null;
let companyId: number;
let ownerId: number;
let subscriptionId: string;
let linkSeq = 0;

const transactions = new Map<string, WompiTransaction>();
const wompi = {
  getTransaction: jest.fn((id: string) => {
    const tx = transactions.get(id);
    return tx ? Promise.resolve(tx) : Promise.reject(new Error(`tx ${id} no existe`));
  }),
};
const alerts = { notify: jest.fn().mockResolvedValue(undefined) };

function buildApply(): ApplyWompiTransactionAction {
  const db = ds as DataSource;
  return new ApplyWompiTransactionAction(
    wompi as never,
    alerts as never,
    db,
    db.getRepository(SubscriptionPayment),
  );
}

async function resetSubscription(expiresAt: Date): Promise<void> {
  await (ds as DataSource).query(
    `UPDATE subscriptions
        SET started_at = $2, expires_at = $3, plan = 'free', status = 'trialing',
            requested_plan = NULL, plan_requested_at = NULL,
            scheduled_plan = NULL, plan_scheduled_at = NULL
      WHERE id = $1`,
    [subscriptionId, new Date(expiresAt.getTime() - 10 * DAY), expiresAt],
  );
}

async function insertPayment(plan: 'monthly' | 'annual' = 'monthly'): Promise<SubscriptionPayment> {
  linkSeq += 1;
  const link = `E2E${Date.now()}${linkSeq}`;
  const amount = plan === 'monthly' ? 5_000_000 : 40_000_000;
  const repo = (ds as DataSource).getRepository(SubscriptionPayment);
  return repo.save(
    repo.create({
      reference: randomUUID(),
      company_id: String(companyId),
      subscription_id: subscriptionId,
      owner_user_id: String(ownerId),
      plan: plan as never,
      amount_in_cents: String(amount),
      currency: 'COP',
      days_granted: plan === 'monthly' ? 30 : 365,
      provider: 'wompi',
      provider_environment: 'sandbox',
      payment_link_id: link,
      checkout_url: `https://checkout.wompi.co/l/${link}`,
      link_expires_at: new Date(Date.now() + DAY),
      status: SubscriptionPaymentStatus.PENDING,
    }),
  );
}

function registerTx(
  id: string,
  payment: SubscriptionPayment,
  status: string,
  overrides: Partial<WompiTransaction> = {},
): string {
  transactions.set(id, {
    id,
    status,
    amount_in_cents: Number(payment.amount_in_cents),
    currency: 'COP',
    payment_link_id: payment.payment_link_id,
    payment_method_type: 'CARD',
    status_message: status === 'DECLINED' ? 'Fondos insuficientes' : null,
    ...overrides,
  });
  return id;
}

async function loadSubscription(): Promise<Subscription> {
  return (ds as DataSource)
    .getRepository(Subscription)
    .findOneOrFail({ where: { id: subscriptionId } });
}

async function loadPayment(id: string): Promise<SubscriptionPayment> {
  return (ds as DataSource).getRepository(SubscriptionPayment).findOneOrFail({ where: { id } });
}

beforeAll(async () => {
  ds = await tryInitDataSource();
  if (!ds) {
    return;
  }
  companyId = await createDisposableCompany(ds, '__E2E_BILLING_WOMPI__');
  ownerId = await insertOwnerUser(ds, companyId, 'billing');
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
  await ds.query(`DROP TRIGGER IF EXISTS e2e_billing_fail ON subscriptions`);
  await ds.query(`DROP FUNCTION IF EXISTS e2e_billing_fail_fn()`);
  await cleanupCompany(ds, companyId);
  await ds.destroy();
});

beforeEach(() => {
  alerts.notify.mockClear();
  wompi.getTransaction.mockClear();
});

const itDb = (name: string, fn: () => Promise<void>): void =>
  it(name, async () => {
    if (!ds) {
      console.warn(`[e2e billing] sin BD, se omite: ${name}`);
      return;
    }
    await fn();
  });

describe('Cobro Wompi — aplicar transacciones (BD real)', () => {
  itDb(
    'APROBADA: suma 30 días a lo que quedaba, activa el plan y marca el pago aplicado',
    async () => {
      const expires = new Date(Date.now() + 5 * DAY);
      await resetSubscription(expires);
      const payment = await insertPayment('monthly');
      const txId = registerTx(`TX-OK-${payment.id}`, payment, 'APPROVED');

      const result = await buildApply().execute(txId, 'webhook');

      expect(result.outcome).toBe('approve');
      const sub = await loadSubscription();
      expect(sub.expires_at.getTime()).toBe(expires.getTime() + 30 * DAY);
      expect(sub.plan).toBe('monthly');
      expect(sub.status).toBe('active');
      expect(sub.requested_plan).toBeNull();

      const stored = await loadPayment(payment.id);
      expect(stored.status).toBe(SubscriptionPaymentStatus.APPROVED);
      expect(stored.applied_at).not.toBeNull();
      expect(stored.provider_transaction_id).toBe(txId);
      expect(stored.period_ends_at?.getTime()).toBe(sub.expires_at.getTime());
      expect(alerts.notify).not.toHaveBeenCalled();
    },
  );

  itDb('idempotente: el mismo webhook tres veces carga los días UNA sola vez', async () => {
    const expires = new Date(Date.now() + 2 * DAY);
    await resetSubscription(expires);
    const payment = await insertPayment('annual');
    const txId = registerTx(`TX-IDEM-${payment.id}`, payment, 'APPROVED');
    const apply = buildApply();

    await apply.execute(txId, 'webhook');
    const second = await apply.execute(txId, 'webhook');
    await apply.execute(txId, 'return');

    expect(second.outcome).toBe('already_applied');
    const sub = await loadSubscription();
    expect(sub.expires_at.getTime()).toBe(expires.getTime() + 365 * DAY);
  });

  itDb(
    'concurrente: webhook + regreso + barrido a la vez → los días se cargan una vez',
    async () => {
      const expires = new Date(Date.now() + 3 * DAY);
      await resetSubscription(expires);
      const payment = await insertPayment('monthly');
      const txId = registerTx(`TX-RACE-${payment.id}`, payment, 'APPROVED');

      const outcomes = await Promise.all(
        ['webhook', 'return', 'reconcile', 'webhook', 'return'].map((source) =>
          buildApply().execute(txId, source as never),
        ),
      );

      expect(outcomes.filter((r) => r.outcome === 'approve')).toHaveLength(1);
      expect(outcomes.filter((r) => r.outcome === 'already_applied')).toHaveLength(4);
      const sub = await loadSubscription();
      expect(sub.expires_at.getTime()).toBe(expires.getTime() + 30 * DAY);
    },
  );

  itDb('suscripción VENCIDA: el período nuevo arranca hoy, no desde el vencimiento', async () => {
    await resetSubscription(new Date(Date.now() - 20 * DAY));
    const payment = await insertPayment('monthly');
    const txId = registerTx(`TX-EXP-${payment.id}`, payment, 'APPROVED');

    const before = Date.now();
    await buildApply().execute(txId, 'webhook');

    const sub = await loadSubscription();
    expect(sub.started_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(sub.expires_at.getTime() - sub.started_at.getTime()).toBe(30 * DAY);
  });

  itDb(
    'RECHAZADA: no carga días, informa el motivo y marca la suscripción con pago fallido',
    async () => {
      const expires = new Date(Date.now() + 4 * DAY);
      await resetSubscription(expires);
      await (ds as DataSource).query(
        `UPDATE subscriptions SET status = 'payment_pending', requested_plan = 'monthly', plan_requested_at = now() WHERE id = $1`,
        [subscriptionId],
      );
      const payment = await insertPayment('monthly');
      const txId = registerTx(`TX-DEC-${payment.id}`, payment, 'DECLINED');

      const result = await buildApply().execute(txId, 'return');

      expect(result.outcome).toBe('reject');
      const stored = await loadPayment(payment.id);
      expect(stored.status).toBe(SubscriptionPaymentStatus.DECLINED);
      expect(stored.applied_at).toBeNull();
      expect(stored.failure_reason).toMatch(/Fondos insuficientes/);
      const sub = await loadSubscription();
      expect(sub.status).toBe('payment_failed');
      expect(sub.expires_at.getTime()).toBe(expires.getTime());
    },
  );

  itDb('rechazada y luego REINTENTO aprobado en el mismo link → se cargan los días', async () => {
    const expires = new Date(Date.now() + 1 * DAY);
    await resetSubscription(expires);
    const payment = await insertPayment('monthly');
    const declined = registerTx(`TX-R1-${payment.id}`, payment, 'DECLINED');
    const approved = registerTx(`TX-R2-${payment.id}`, payment, 'APPROVED');
    const apply = buildApply();

    await apply.execute(declined, 'webhook');
    await apply.execute(approved, 'webhook');
    // El evento viejo del rechazo llega tarde: no deshace nada.
    const late = await apply.execute(declined, 'webhook');

    expect(late.outcome).toBe('already_applied');
    const stored = await loadPayment(payment.id);
    expect(stored.status).toBe(SubscriptionPaymentStatus.APPROVED);
    expect(stored.provider_transaction_id).toBe(approved);
    expect((await loadSubscription()).expires_at.getTime()).toBe(expires.getTime() + 30 * DAY);
  });

  itDb('APROBADA por un monto distinto → revisión, NO carga días y avisa al operador', async () => {
    const expires = new Date(Date.now() + 6 * DAY);
    await resetSubscription(expires);
    const payment = await insertPayment('annual');
    const txId = registerTx(`TX-MIS-${payment.id}`, payment, 'APPROVED', { amount_in_cents: 100 });

    const result = await buildApply().execute(txId, 'webhook');

    expect(result.outcome).toBe('needs_review');
    expect((await loadPayment(payment.id)).status).toBe(SubscriptionPaymentStatus.NEEDS_REVIEW);
    expect((await loadSubscription()).expires_at.getTime()).toBe(expires.getTime());
    expect(alerts.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/no cuadra/) }),
    );
  });

  itDb('PENDIENTE (PSE/Nequi): guarda la transacción y espera, sin cargar días', async () => {
    const expires = new Date(Date.now() + 6 * DAY);
    await resetSubscription(expires);
    const payment = await insertPayment('monthly');
    const txId = registerTx(`TX-PEN-${payment.id}`, payment, 'PENDING');

    expect((await buildApply().execute(txId, 'return')).outcome).toBe('pending');
    const stored = await loadPayment(payment.id);
    expect(stored.status).toBe(SubscriptionPaymentStatus.PENDING);
    expect(stored.provider_transaction_id).toBe(txId);
    expect((await loadSubscription()).expires_at.getTime()).toBe(expires.getTime());
  });

  itDb('transacción de un link que no es nuestro → no toca nada', async () => {
    transactions.set('TX-ALIEN', {
      id: 'TX-ALIEN',
      status: 'APPROVED',
      amount_in_cents: 5_000_000,
      currency: 'COP',
      payment_link_id: 'LINK-DE-OTRO-PRODUCTO',
    });
    const result = await buildApply().execute('TX-ALIEN', 'webhook');
    expect(result).toEqual({ payment: null, outcome: 'unknown_link' });
  });

  itDb(
    'ATOMICIDAD: si falla la suscripción, el pago NO queda aprobado; al reintentar se aplica',
    async () => {
      const expires = new Date(Date.now() + 8 * DAY);
      await resetSubscription(expires);
      const payment = await insertPayment('monthly');
      const txId = registerTx(`TX-ATOM-${payment.id}`, payment, 'APPROVED');

      // Simula una falla de la BD justo al escribir la suscripción.
      await (ds as DataSource).query(`
      CREATE OR REPLACE FUNCTION e2e_billing_fail_fn() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'falla simulada'; END $$ LANGUAGE plpgsql
    `);
      await (ds as DataSource).query(`
      CREATE TRIGGER e2e_billing_fail BEFORE UPDATE ON subscriptions
      FOR EACH ROW WHEN (OLD.id = ${Number(subscriptionId)}) EXECUTE FUNCTION e2e_billing_fail_fn()
    `);

      await expect(buildApply().execute(txId, 'webhook')).rejects.toThrow(/falla simulada/);

      const afterFailure = await loadPayment(payment.id);
      expect(afterFailure.status).toBe(SubscriptionPaymentStatus.PENDING);
      expect(afterFailure.applied_at).toBeNull();
      // Quedó el id para que el barrido reintente.
      expect(afterFailure.provider_transaction_id).toBe(txId);
      expect(alerts.notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/NO se pudo aplicar/) }),
      );

      await (ds as DataSource).query(`DROP TRIGGER e2e_billing_fail ON subscriptions`);

      // El barrido lo encuentra y lo aplica.
      const scheduler = new BillingScheduler(
        buildApply(),
        {
          getOrThrow: () =>
            resolveBillingConfig({
              WOMPI_PRIVATE_KEY: 'prv_test_K',
              WOMPI_EVENTS_SECRET: 'test_events_S',
            }),
        } as unknown as ConfigService,
        (ds as DataSource).getRepository(SubscriptionPayment),
      );
      const run = await scheduler.reconcile();
      expect(run.checked).toBeGreaterThanOrEqual(1);

      expect((await loadPayment(payment.id)).status).toBe(SubscriptionPaymentStatus.APPROVED);
      expect((await loadSubscription()).expires_at.getTime()).toBe(expires.getTime() + 30 * DAY);
    },
  );

  itDb('la BD impide un pago "aprobado" sin días cargados (CHECK)', async () => {
    const payment = await insertPayment('monthly');
    await expect(
      (ds as DataSource).query(
        `UPDATE subscription_payments SET status = 'approved' WHERE id = $1`,
        [payment.id],
      ),
    ).rejects.toThrow(/chk_subscription_payments_approved_applied/);
  });

  itDb('la BD impide que una transacción se use en dos pagos (índice único)', async () => {
    const a = await insertPayment('monthly');
    const b = await insertPayment('monthly');
    await (ds as DataSource).query(
      `UPDATE subscription_payments SET provider_transaction_id = 'TX-UNIQ' WHERE id = $1`,
      [a.id],
    );
    await expect(
      (ds as DataSource).query(
        `UPDATE subscription_payments SET provider_transaction_id = 'TX-UNIQ' WHERE id = $1`,
        [b.id],
      ),
    ).rejects.toThrow(/idx_subscription_payments_transaction_id_unique/);
  });

  itDb(
    'el barrido marca vencidos los links sin pagar (pasada la gracia) y no toca los vigentes',
    async () => {
      const stale = await insertPayment('monthly');
      const fresh = await insertPayment('monthly');
      await (ds as DataSource).query(
        `UPDATE subscription_payments SET link_expires_at = now() - interval '3 days' WHERE id = $1`,
        [stale.id],
      );
      const scheduler = new BillingScheduler(
        buildApply(),
        {
          getOrThrow: () =>
            resolveBillingConfig({
              WOMPI_PRIVATE_KEY: 'prv_test_K',
              WOMPI_EVENTS_SECRET: 'test_events_S',
            }),
        } as unknown as ConfigService,
        (ds as DataSource).getRepository(SubscriptionPayment),
      );
      await scheduler.reconcile();

      expect((await loadPayment(stale.id)).status).toBe(SubscriptionPaymentStatus.EXPIRED);
      expect((await loadPayment(fresh.id)).status).toBe(SubscriptionPaymentStatus.PENDING);

      // Un link vencido que resulta pagado se aplica igual: si pagó, se carga.
      const expires = new Date(Date.now() + 2 * DAY);
      await resetSubscription(expires);
      const txId = registerTx(`TX-LATE-${stale.id}`, stale, 'APPROVED');
      expect((await buildApply().execute(txId, 'webhook')).outcome).toBe('approve');
      expect((await loadSubscription()).expires_at.getTime()).toBe(expires.getTime() + 30 * DAY);
    },
  );
});

describe('Cobro Wompi — pantalla de regreso (BD real)', () => {
  function buildConfirm(): ConfirmPaymentAction {
    const db = ds as DataSource;
    return new ConfirmPaymentAction(
      buildApply(),
      new SubscriptionsService(db.getRepository(Subscription)),
      db.getRepository(SubscriptionPayment),
    );
  }

  itDb('con el ?id= del regreso verifica en Wompi y devuelve el pago ya aprobado', async () => {
    await resetSubscription(new Date(Date.now() + DAY));
    const payment = await insertPayment('monthly');
    const txId = registerTx(`TX-RET-${payment.id}`, payment, 'APPROVED');

    const dto = await buildConfirm().execute(ownerId, companyId, payment.reference, txId);
    expect(dto.status).toBe('approved');
    expect(dto.period_ends_at).not.toBeNull();
  });

  itDb('un ?id= de OTRO link no aprueba este pago', async () => {
    const mine = await insertPayment('monthly');
    const other = await insertPayment('monthly');
    const txOther = registerTx(`TX-OTHER-${other.id}`, other, 'DECLINED');

    const dto = await buildConfirm().execute(ownerId, companyId, mine.reference, txOther);
    expect(dto.status).toBe('pending');
    expect(dto.transaction_id).toBeNull();
  });

  itDb('si Wompi no responde, devuelve el estado conocido (pendiente) sin error', async () => {
    const payment = await insertPayment('monthly');
    const dto = await buildConfirm().execute(ownerId, companyId, payment.reference, 'TX-NO-EXISTE');
    expect(dto.status).toBe('pending');
  });

  itDb('otro usuario no puede ver el pago (403) y una referencia ajena da 404', async () => {
    const payment = await insertPayment('monthly');
    await expect(
      buildConfirm().execute(ownerId + 999, companyId, payment.reference),
    ).rejects.toThrow();
    await expect(
      buildConfirm().execute(ownerId, companyId, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow(/Pago no encontrado/);
  });
});

describe('Cobro Wompi — referencia vacía', () => {
  itDb(
    'una referencia vacía nunca resuelve "el primer pago" (TypeORM ignora undefined)',
    async () => {
      const db = ds as DataSource;
      const confirm = new ConfirmPaymentAction(
        buildApply(),
        new SubscriptionsService(db.getRepository(Subscription)),
        db.getRepository(SubscriptionPayment),
      );
      await expect(confirm.execute(ownerId, companyId, '')).rejects.toThrow(/Pago no encontrado/);
      await expect(
        confirm.execute(ownerId, companyId, undefined as unknown as string),
      ).rejects.toThrow(/Pago no encontrado/);
    },
  );
});
