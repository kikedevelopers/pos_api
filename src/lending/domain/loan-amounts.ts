import Big from 'big.js';

import type { LoanPlanType } from './loan-plan-rules';

/**
 * Montos pactados de un préstamo, calculados al prestar con las condiciones
 * del plan. Puro y con Big.js. Debe dar EXACTAMENTE lo mismo que la simulación
 * del cliente (`placepos/.../LoanPlans/utils/loanPlanMath.ts`): lo que el
 * prestamista vio en pantalla es lo que queda guardado.
 *
 *   - interest_only: sin cuota fija (el cliente paga el interés del saldo más
 *     el abono que quiera).
 *   - fixed_installment: cuota francesa A = P·r / (1 − (1 + r)^−n); con tasa 0,
 *     A = P / n. Redondeo a 2 decimales HALF_UP.
 *   - daily_installment: la misma cuota, repartida en `collection_days` pagos
 *     (A / días, 2 decimales HALF_UP).
 */
export interface LoanTerms {
  plan_type: LoanPlanType;
  interest_rate: number;
  installments_count: number | null;
  collection_days: number | null;
}

export interface LoanAmounts {
  installment_amount: number | null;
  daily_amount: number | null;
}

const money = (value: Big): number => value.round(2, Big.roundHalfUp).toNumber();

export function fixedInstallment(principal: Big, ratePercent: Big, n: number): Big {
  const r = ratePercent.div(100);
  if (r.eq(0)) return principal.div(n);
  const factor = new Big(1).plus(r).pow(n);
  return principal.times(r).times(factor).div(factor.minus(1));
}

export function computeLoanAmounts(terms: LoanTerms, principal: number | string): LoanAmounts {
  if (terms.plan_type === 'interest_only') {
    return { installment_amount: null, daily_amount: null };
  }
  const n = terms.installments_count ?? 0;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('El plan no tiene un número de cuotas válido.');
  }
  const installment = money(fixedInstallment(new Big(principal), new Big(terms.interest_rate), n));
  if (terms.plan_type === 'fixed_installment') {
    return { installment_amount: installment, daily_amount: null };
  }
  const days = terms.collection_days ?? 0;
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('El plan no tiene días de cobro válidos.');
  }
  return { installment_amount: installment, daily_amount: money(new Big(installment).div(days)) };
}
