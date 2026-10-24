import { BadRequestException } from '@nestjs/common';
import Big from 'big.js';

/**
 * Reglas de un PLAN DE PRÉSTAMO (la plantilla que el prestamista guarda para
 * prestar más rápido). Puras para poder probarlas sin base de datos.
 *
 * Tipos de plan:
 *
 *   - `interest_only` (interés fijo): cada periodo se paga el interés sobre el
 *     SALDO de capital que queda, más lo que el cliente decida abonar a
 *     capital. No tiene número de cuotas.
 *   - `fixed_installment` (cuota fija): cuota constante que salda el préstamo
 *     en `installments_count` periodos; el interés de cada periodo se calcula
 *     sobre el saldo que queda y el resto de la cuota va a capital.
 *   - `daily_installment` (cuota diaria): la misma cuota fija por periodo, pero
 *     cobrada en `collection_days` pagos diarios dentro del periodo.
 *
 * La tasa (`interest_rate`, en %) es POR PERIODO (`rate_period`): mensual,
 * quincenal o semanal.
 */

export const LOAN_PLAN_TYPES = ['interest_only', 'fixed_installment', 'daily_installment'] as const;
export type LoanPlanType = (typeof LOAN_PLAN_TYPES)[number];

export const LOAN_RATE_PERIODS = ['monthly', 'biweekly', 'weekly'] as const;
export type LoanRatePeriod = (typeof LOAN_RATE_PERIODS)[number];

/** Días máximos de cobro dentro de cada periodo (no se cobra más de los días que tiene). */
export const MAX_COLLECTION_DAYS: Record<LoanRatePeriod, number> = {
  monthly: 31,
  biweekly: 15,
  weekly: 7,
};

export const MAX_INSTALLMENTS = 360;
export const MAX_INTEREST_RATE = 100;
export const NAME_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 500;

export interface LoanPlanInput {
  name?: string | null;
  description?: string | null;
  plan_type?: string | null;
  interest_rate?: number | string | null;
  rate_period?: string | null;
  installments_count?: number | null;
  collection_days?: number | null;
}

export interface NormalizedLoanPlan {
  name: string;
  description: string | null;
  plan_type: LoanPlanType;
  interest_rate: number;
  rate_period: LoanRatePeriod;
  installments_count: number | null;
  collection_days: number | null;
}

const fail = (message: string): never => {
  throw new BadRequestException(message);
};

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

/** ¿Este tipo de plan lleva número de cuotas? */
export const requiresInstallments = (type: LoanPlanType): boolean => type !== 'interest_only';

/** ¿Este tipo de plan lleva días de cobro? */
export const requiresCollectionDays = (type: LoanPlanType): boolean =>
  type === 'daily_installment';

/**
 * Valida y normaliza un plan COMPLETO (al crear, o el resultado de mezclar el
 * guardado con un cambio parcial). Lanza 400 con un mensaje para el usuario.
 *
 * Los campos que el tipo no usa se descartan (null) en vez de rechazarse: al
 * cambiar un plan de "cuota fija" a "interés fijo" el formulario no tiene que
 * acordarse de limpiar el número de cuotas.
 */
export function normalizeLoanPlan(input: LoanPlanInput): NormalizedLoanPlan {
  const name = (input.name ?? '').trim();
  if (!name) fail('El nombre del plan es requerido.');
  if (name.length > NAME_MAX_LENGTH) {
    fail(`El nombre del plan no puede pasar de ${NAME_MAX_LENGTH} caracteres.`);
  }

  const description = (input.description ?? '').trim();
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    fail(`La descripción no puede pasar de ${DESCRIPTION_MAX_LENGTH} caracteres.`);
  }

  const plan_type = input.plan_type as LoanPlanType;
  if (!(LOAN_PLAN_TYPES as readonly string[]).includes(String(plan_type))) {
    fail('El tipo de plan no es válido.');
  }

  const rate_period = input.rate_period as LoanRatePeriod;
  if (!(LOAN_RATE_PERIODS as readonly string[]).includes(String(rate_period))) {
    fail('El periodo de la tasa no es válido.');
  }

  const rawRate = input.interest_rate;
  if (rawRate === null || rawRate === undefined || String(rawRate).trim() === '') {
    fail('La tasa de interés es requerida.');
  }
  let rate: Big;
  try {
    rate = new Big(rawRate as number | string);
  } catch {
    return fail('La tasa de interés no es un número válido.');
  }
  if (rate.lt(0) || rate.gt(MAX_INTEREST_RATE)) {
    fail(`La tasa de interés debe estar entre 0 y ${MAX_INTEREST_RATE} %.`);
  }
  if (!rate.eq(rate.round(4, Big.roundDown))) {
    fail('La tasa de interés admite máximo 4 decimales.');
  }

  let installments_count: number | null = null;
  if (requiresInstallments(plan_type)) {
    const count = input.installments_count;
    if (!isInteger(count) || count < 1 || count > MAX_INSTALLMENTS) {
      fail(`El número de cuotas debe ser un entero entre 1 y ${MAX_INSTALLMENTS}.`);
    }
    installments_count = count as number;
  }

  let collection_days: number | null = null;
  if (requiresCollectionDays(plan_type)) {
    const days = input.collection_days;
    const max = MAX_COLLECTION_DAYS[rate_period];
    if (!isInteger(days) || days < 1 || days > max) {
      fail(`Los días de cobro deben ser un entero entre 1 y ${max} para este periodo.`);
    }
    collection_days = days as number;
  }

  return {
    name,
    description: description || null,
    plan_type,
    interest_rate: rate.toNumber(),
    rate_period,
    installments_count,
    collection_days,
  };
}
