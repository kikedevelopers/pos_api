import { SubscriptionPaymentStatus } from '../../entities/subscription-payment.entity';
import { computeExtension, describeRejection, evaluateTransaction } from '../payment-outcome';

const payment = { payment_link_id: 'LINK1', amount_in_cents: '40000000', currency: 'COP' };
const approved = {
  status: 'APPROVED',
  amount_in_cents: 40_000_000,
  currency: 'COP',
  payment_link_id: 'LINK1',
};

describe('evaluateTransaction', () => {
  it('APROBADA, mismo link, monto y moneda → aprobar', () => {
    expect(evaluateTransaction(payment, approved)).toEqual({ kind: 'approve' });
  });

  it('APROBADA por MENOS dinero → revisión, nunca aprobar', () => {
    const outcome = evaluateTransaction(payment, { ...approved, amount_in_cents: 100 });
    expect(outcome.kind).toBe('needs_review');
  });

  it('APROBADA por más dinero → revisión (no se regala ni se traga la diferencia)', () => {
    expect(evaluateTransaction(payment, { ...approved, amount_in_cents: 40_000_001 }).kind).toBe(
      'needs_review',
    );
  });

  it('APROBADA en otra moneda → revisión', () => {
    expect(evaluateTransaction(payment, { ...approved, currency: 'USD' }).kind).toBe(
      'needs_review',
    );
  });

  it('transacción de otro link → ajena (no toca este pago)', () => {
    expect(evaluateTransaction(payment, { ...approved, payment_link_id: 'OTRO' }).kind).toBe(
      'foreign',
    );
    expect(evaluateTransaction(payment, { ...approved, payment_link_id: null }).kind).toBe(
      'foreign',
    );
  });

  it.each([
    ['DECLINED', SubscriptionPaymentStatus.DECLINED],
    ['VOIDED', SubscriptionPaymentStatus.VOIDED],
    ['ERROR', SubscriptionPaymentStatus.ERROR],
  ])('%s → rechazo con su estado', (status, expected) => {
    expect(evaluateTransaction(payment, { ...approved, status })).toEqual({
      kind: 'reject',
      status: expected,
    });
  });

  it('PENDING o un estado desconocido → esperar (ni aprobar ni rechazar a ciegas)', () => {
    expect(evaluateTransaction(payment, { ...approved, status: 'PENDING' }).kind).toBe('pending');
    expect(evaluateTransaction(payment, { ...approved, status: 'WHATEVER' }).kind).toBe('pending');
  });

  it('un monto guardado corrupto nunca aprueba', () => {
    expect(evaluateTransaction({ ...payment, amount_in_cents: 'abc' }, approved).kind).toBe(
      'needs_review',
    );
  });
});

describe('computeExtension', () => {
  const now = new Date('2026-10-28T15:00:00.000Z');

  it('vigente: los días se SUMAN a los que le quedan', () => {
    const expires = new Date('2026-11-02T15:00:00.000Z');
    const result = computeExtension(expires, 30, now);
    expect(result.was_expired).toBe(false);
    expect(result.period_starts_at).toEqual(expires);
    expect(result.period_ends_at.toISOString()).toBe('2026-12-02T15:00:00.000Z');
  });

  it('vencida: el período arranca hoy (no paga los días bloqueado)', () => {
    const result = computeExtension(new Date('2026-09-01T00:00:00.000Z'), 365, now);
    expect(result.was_expired).toBe(true);
    expect(result.period_starts_at).toEqual(now);
    expect(result.period_ends_at.toISOString()).toBe('2027-10-28T15:00:00.000Z');
  });

  it('vence exactamente ahora: cuenta como vencida', () => {
    expect(computeExtension(now, 30, now).was_expired).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN])('días inválidos (%p) lanzan', (days) => {
    expect(() => computeExtension(now, days, now)).toThrow();
  });
});

describe('describeRejection', () => {
  it('explica el rechazo e incluye el detalle del medio de pago', () => {
    expect(describeRejection(SubscriptionPaymentStatus.DECLINED, 'Fondos insuficientes')).toBe(
      'Tu banco o medio de pago rechazó la transacción. Detalle: Fondos insuficientes',
    );
    expect(describeRejection(SubscriptionPaymentStatus.VOIDED)).toMatch(/anulada/);
    expect(describeRejection(SubscriptionPaymentStatus.ERROR, '  ')).not.toMatch(/Detalle/);
  });
});
