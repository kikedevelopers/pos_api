import { SubscriptionStatus } from '../../entities/subscription.entity';
import { isSubscriptionExpired, resolveEffectiveStatus, isPaidPlan } from '../subscription-state';
import { SubscriptionPlan } from '../../entities/subscription.entity';

// ---------------------------------------------------------------------------
// El cruce entre "hasta cuándo" (expires_at) y "por qué" (status).
//
// Es lo único que el dueño lee cuando la app deja de abrirle. Decirle "vencida"
// a quien tiene un cobro rebotado lo manda a llamar a soporte en vez de a
// reintentar el pago; decirle "pago pendiente" a quien simplemente se le acabó
// la prueba lo deja esperando un cobro que nadie va a hacer.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-15T12:00:00.000Z');
const FUTURE = new Date('2026-08-20T12:00:00.000Z');
const PAST = new Date('2026-08-10T12:00:00.000Z');

describe('isSubscriptionExpired', () => {
  it('una fecha futura no está vencida', () => {
    expect(isSubscriptionExpired(FUTURE, NOW)).toBe(false);
  });

  it('una fecha pasada está vencida', () => {
    expect(isSubscriptionExpired(PAST, NOW)).toBe(true);
  });

  it('el instante exacto del vencimiento ya cuenta como vencida', () => {
    // El límite se cierra hacia el lado que bloquea: `expires_at` es el fin de
    // la ventana, no un segundo más de servicio.
    expect(isSubscriptionExpired(NOW, NOW)).toBe(true);
  });
});

describe('resolveEffectiveStatus · suscripción vigente', () => {
  const vigente = (status: SubscriptionStatus) =>
    resolveEffectiveStatus({ status, expires_at: FUTURE, now: NOW });

  it('en prueba se ve como prueba', () => {
    expect(vigente(SubscriptionStatus.TRIALING)).toBe('trialing');
  });

  it('pagada y al día se ve activa', () => {
    expect(vigente(SubscriptionStatus.ACTIVE)).toBe('active');
  });

  it('con un cobro rebotado avisa aunque todavía funcione', () => {
    // Sigue vigente, pero callarlo ahora es garantizar la sorpresa el día del
    // corte.
    expect(vigente(SubscriptionStatus.PAYMENT_FAILED)).toBe('payment_failed');
  });

  it('con un plan pedido y sin pagar lo dice', () => {
    expect(vigente(SubscriptionStatus.PAYMENT_PENDING)).toBe('payment_pending');
  });

  it('cancelada sigue corriendo hasta la fecha, y se ve cancelada', () => {
    expect(vigente(SubscriptionStatus.CANCELED)).toBe('canceled');
  });
});

describe('resolveEffectiveStatus · suscripción vencida', () => {
  const vencida = (status: SubscriptionStatus) =>
    resolveEffectiveStatus({ status, expires_at: PAST, now: NOW });

  it('la prueba que se acabó es "vencida", sin hablar de pagos', () => {
    expect(vencida(SubscriptionStatus.TRIALING)).toBe('expired');
  });

  it('un plan pagado que no se renovó también es "vencida"', () => {
    expect(vencida(SubscriptionStatus.ACTIVE)).toBe('expired');
  });

  it('el pago rebotado sobrevive al vencimiento: es la explicación', () => {
    expect(vencida(SubscriptionStatus.PAYMENT_FAILED)).toBe('payment_failed');
  });

  it('el pago sin procesar sobrevive al vencimiento', () => {
    expect(vencida(SubscriptionStatus.PAYMENT_PENDING)).toBe('payment_pending');
  });

  it('la cancelación sobrevive al vencimiento', () => {
    expect(vencida(SubscriptionStatus.CANCELED)).toBe('canceled');
  });
});

describe('isPaidPlan', () => {
  it('free no se cobra', () => {
    expect(isPaidPlan(SubscriptionPlan.FREE)).toBe(false);
  });

  it('mensual y anual sí', () => {
    expect(isPaidPlan(SubscriptionPlan.MONTHLY)).toBe(true);
    expect(isPaidPlan(SubscriptionPlan.ANNUAL)).toBe(true);
  });
});
