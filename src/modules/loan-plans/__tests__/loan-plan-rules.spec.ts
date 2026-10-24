import { BadRequestException } from '@nestjs/common';

import {
  MAX_COLLECTION_DAYS,
  normalizeLoanPlan,
  requiresCollectionDays,
  requiresInstallments,
  type LoanPlanInput,
} from '../internal/loan-plan-rules';

const base = (over: LoanPlanInput = {}): LoanPlanInput => ({
  name: 'Mensual 6%',
  plan_type: 'interest_only',
  interest_rate: 6,
  rate_period: 'monthly',
  ...over,
});

const expectBad = (input: LoanPlanInput, message: RegExp): void => {
  let error: unknown;
  try {
    normalizeLoanPlan(input);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(BadRequestException);
  expect((error as BadRequestException).message).toMatch(message);
};

describe('normalizeLoanPlan', () => {
  it('interés fijo: sin cuotas ni días, aunque lleguen', () => {
    expect(
      normalizeLoanPlan(base({ installments_count: 12, collection_days: 26, name: '  Mensual 6%  ' })),
    ).toEqual({
      name: 'Mensual 6%',
      description: null,
      plan_type: 'interest_only',
      interest_rate: 6,
      rate_period: 'monthly',
      installments_count: null,
      collection_days: null,
    });
  });

  it('cuota fija: exige el número de cuotas y descarta los días', () => {
    const plan = normalizeLoanPlan(
      base({ plan_type: 'fixed_installment', installments_count: 12, collection_days: 20 }),
    );
    expect(plan.installments_count).toBe(12);
    expect(plan.collection_days).toBeNull();
  });

  it('cuota diaria: exige cuotas y días de cobro', () => {
    const plan = normalizeLoanPlan(
      base({ plan_type: 'daily_installment', installments_count: 3, collection_days: 26 }),
    );
    expect(plan).toMatchObject({ installments_count: 3, collection_days: 26 });
  });

  it('acepta tasa 0 y tasa con 4 decimales, también como texto', () => {
    expect(normalizeLoanPlan(base({ interest_rate: 0 })).interest_rate).toBe(0);
    expect(normalizeLoanPlan(base({ interest_rate: '2.5125' })).interest_rate).toBe(2.5125);
  });

  it('descripción vacía queda null; con texto se recorta', () => {
    expect(normalizeLoanPlan(base({ description: '   ' })).description).toBeNull();
    expect(normalizeLoanPlan(base({ description: ' Clientes fijos ' })).description).toBe(
      'Clientes fijos',
    );
  });

  it.each([
    [{ name: '   ' }, /nombre del plan es requerido/],
    [{ name: 'x'.repeat(101) }, /no puede pasar de 100/],
    [{ description: 'x'.repeat(501) }, /descripción no puede pasar de 500/],
    [{ plan_type: 'gota_a_gota' }, /tipo de plan no es válido/],
    [{ plan_type: null }, /tipo de plan no es válido/],
    [{ rate_period: 'daily' }, /periodo de la tasa no es válido/],
    [{ interest_rate: null }, /tasa de interés es requerida/],
    [{ interest_rate: '' }, /tasa de interés es requerida/],
    [{ interest_rate: 'seis' }, /no es un número válido/],
    [{ interest_rate: -1 }, /entre 0 y 100/],
    [{ interest_rate: 100.01 }, /entre 0 y 100/],
    [{ interest_rate: 1.23456 }, /máximo 4 decimales/],
  ] as [LoanPlanInput, RegExp][])('rechaza %p', (over, message) => {
    expectBad(base(over), message);
  });

  it.each([undefined, null, 0, -2, 2.5, 361])(
    'cuota fija rechaza número de cuotas %p',
    (installments_count) => {
      expectBad(
        base({ plan_type: 'fixed_installment', installments_count: installments_count as number }),
        /número de cuotas debe ser un entero entre 1 y 360/,
      );
    },
  );

  it('cuota diaria: los días no pueden pasar los del periodo', () => {
    const daily = (rate_period: string, collection_days: number) =>
      base({ plan_type: 'daily_installment', installments_count: 2, rate_period, collection_days });

    expect(normalizeLoanPlan(daily('monthly', 31)).collection_days).toBe(31);
    expect(normalizeLoanPlan(daily('biweekly', 15)).collection_days).toBe(15);
    expect(normalizeLoanPlan(daily('weekly', 7)).collection_days).toBe(7);
    expectBad(daily('weekly', 8), /entre 1 y 7/);
    expectBad(daily('biweekly', 16), /entre 1 y 15/);
    expectBad(daily('monthly', 32), /entre 1 y 31/);
    expectBad(daily('monthly', 0), /entre 1 y 31/);
  });

  it('cuota diaria sin días de cobro: 400', () => {
    expectBad(
      base({ plan_type: 'daily_installment', installments_count: 2 }),
      /días de cobro/,
    );
  });
});

describe('requisitos por tipo', () => {
  it('cuotas: todo menos interés fijo', () => {
    expect(requiresInstallments('interest_only')).toBe(false);
    expect(requiresInstallments('fixed_installment')).toBe(true);
    expect(requiresInstallments('daily_installment')).toBe(true);
  });

  it('días de cobro: solo cuota diaria', () => {
    expect(requiresCollectionDays('interest_only')).toBe(false);
    expect(requiresCollectionDays('fixed_installment')).toBe(false);
    expect(requiresCollectionDays('daily_installment')).toBe(true);
  });

  it('máximo de días por periodo', () => {
    expect(MAX_COLLECTION_DAYS).toEqual({ monthly: 31, biweekly: 15, weekly: 7 });
  });
});
