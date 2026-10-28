import { SubscriptionPlan } from '@/modules/subscriptions/entities/subscription.entity';

/**
 * Lo que se cobra por cada plan y cuántos días compra.
 *
 * El precio vive en el SERVIDOR: el cliente solo dice "quiero el anual" y el
 * monto sale de aquí. Si el monto viniera del navegador, cualquiera podría
 * pagar $1 por un año. Espejo de `placepos_lp/src/lib/data/pricing.ts`, que
 * solo lo MUESTRA (hay un test que vigila que no se desincronicen los precios
 * publicados con los cobrados).
 */
export interface PaidPlanTerms {
  plan: SubscriptionPlan.MONTHLY | SubscriptionPlan.ANNUAL;
  name: string;
  /** Pesos colombianos. */
  price_cop: number;
  /** Lo que se le manda a Wompi: pesos × 100. */
  amount_in_cents: number;
  days: number;
}

export const PAID_PLAN_TERMS: Record<PaidPlanTerms['plan'], PaidPlanTerms> = {
  [SubscriptionPlan.MONTHLY]: {
    plan: SubscriptionPlan.MONTHLY,
    name: 'Mensual',
    price_cop: 50_000,
    amount_in_cents: 5_000_000,
    days: 30,
  },
  [SubscriptionPlan.ANNUAL]: {
    plan: SubscriptionPlan.ANNUAL,
    name: 'Anual',
    price_cop: 400_000,
    amount_in_cents: 40_000_000,
    days: 365,
  },
};

/** Términos del plan, o `null` si no se cobra (`free`) o no existe. */
export function termsForPlan(plan: string): PaidPlanTerms | null {
  // `hasOwn`: `'__proto__'` o `'toString'` no son planes, aunque existan en el objeto.
  return Object.prototype.hasOwnProperty.call(PAID_PLAN_TERMS, plan)
    ? (PAID_PLAN_TERMS as Record<string, PaidPlanTerms>)[plan]
    : null;
}

export const BILLING_CURRENCY = 'COP';

/** Vida del link de pago. Pasado esto, Wompi deja de aceptar pagos en él. */
export const PAYMENT_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Un link pendiente se REUTILIZA si le queda al menos esto de vida: así un
 * dueño que hace clic tres veces no termina con tres links (y, en el peor caso,
 * tres cobros). Con menos margen se crea uno nuevo para que no le venza a
 * mitad del pago.
 */
export const PAYMENT_LINK_REUSE_MIN_REMAINING_MS = 2 * 60 * 60 * 1000;

/**
 * Un pago sin transacción conocida se marca `expired` solo cuando ya pasó
 * esto DESPUÉS de vencer el link. Wompi reintenta el webhook hasta 24 h; antes
 * de eso, "no sabemos nada" no significa "no pagó". Aun así `expired` no es
 * final: si después llega una transacción aprobada, se aplica.
 */
export const PAYMENT_EXPIRE_GRACE_MS = 48 * 60 * 60 * 1000;

/** Ventana del barrido: pagos sin aplicar más viejos que esto ya no se consultan. */
export const RECONCILE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
