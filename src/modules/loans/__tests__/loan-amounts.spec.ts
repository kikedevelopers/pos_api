import { computeLoanAmounts, fixedInstallment } from '../internal/loan-amounts';
import Big from 'big.js';

describe('computeLoanAmounts', () => {
  it('interés fijo: sin cuota ni pago diario', () => {
    expect(
      computeLoanAmounts(
        { plan_type: 'interest_only', interest_rate: 6, installments_count: null, collection_days: null },
        10000,
      ),
    ).toEqual({ installment_amount: null, daily_amount: null });
  });

  it('cuota fija: 10.000 al 6 % en 12 = 1.192,77 (igual que la simulación del cliente)', () => {
    expect(
      computeLoanAmounts(
        { plan_type: 'fixed_installment', interest_rate: 6, installments_count: 12, collection_days: null },
        10000,
      ),
    ).toEqual({ installment_amount: 1192.77, daily_amount: null });
  });

  it('cuota diaria: la cuota repartida en los días de cobro', () => {
    expect(
      computeLoanAmounts(
        { plan_type: 'daily_installment', interest_rate: 6, installments_count: 12, collection_days: 26 },
        10000,
      ),
    ).toEqual({ installment_amount: 1192.77, daily_amount: 45.88 });
  });

  it('tasa 0 divide en partes iguales; acepta el capital como texto (numeric)', () => {
    expect(
      computeLoanAmounts(
        { plan_type: 'fixed_installment', interest_rate: 0, installments_count: 4, collection_days: null },
        '1000.00',
      ).installment_amount,
    ).toBe(250);
  });

  it('plan incoherente (sin cuotas o sin días) lanza', () => {
    expect(() =>
      computeLoanAmounts(
        { plan_type: 'fixed_installment', interest_rate: 6, installments_count: null, collection_days: null },
        100,
      ),
    ).toThrow(/cuotas/);
    expect(() =>
      computeLoanAmounts(
        { plan_type: 'daily_installment', interest_rate: 6, installments_count: 2, collection_days: 0 },
        100,
      ),
    ).toThrow(/días de cobro/);
  });

  it('fixedInstallment sin redondear', () => {
    expect(fixedInstallment(new Big(1200), new Big(0), 12).toNumber()).toBe(100);
  });
});
