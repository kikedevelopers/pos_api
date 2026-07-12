import {
  computeAbonoProfitProportional,
  computeRealizedProfit,
  noteProfitAdjustment,
  noteRevenueAdjustment,
  type NoteTotals,
} from '../internal/profit-model';

const NO_NOTES: NoteTotals = { creditTotal: 0, creditCost: 0, debitTotal: 0, debitCost: 0 };

describe('profit-model (lógica pura de utilidad)', () => {
  describe('computeRealizedProfit (devengada)', () => {
    it('sin notas: es la base SUM(si.profit)', () => {
      expect(computeRealizedProfit(40, NO_NOTES)).toBe(40);
      expect(computeRealizedProfit(0, NO_NOTES)).toBe(0);
    });

    it('NC del mismo día resta su utilidad (fixture nota_credito_mismo_dia)', () => {
      // base 40, NC total 30 / cost 18 → 40 − (30 − 18) = 28.
      const notes: NoteTotals = { creditTotal: 30, creditCost: 18, debitTotal: 0, debitCost: 0 };
      expect(computeRealizedProfit(40, notes)).toBe(28);
    });

    it('ND suma su utilidad', () => {
      // base 40, ND total 30 / cost 18 → 40 + (30 − 18) = 52.
      const notes: NoteTotals = { creditTotal: 0, creditCost: 0, debitTotal: 30, debitCost: 18 };
      expect(computeRealizedProfit(40, notes)).toBe(52);
    });

    it('combina NC y ND', () => {
      const notes: NoteTotals = { creditTotal: 30, creditCost: 18, debitTotal: 10, debitCost: 4 };
      // 40 − 12 + 6 = 34.
      expect(computeRealizedProfit(40, notes)).toBe(34);
    });

    it('no arrastra error de punto flotante (Big.js)', () => {
      const notes: NoteTotals = { creditTotal: 0.2, creditCost: 0.1, debitTotal: 0, debitCost: 0 };
      // 0.1 − (0.2 − 0.1) = 0.1 − 0.1 = 0 (no 0.0000000000…).
      expect(computeRealizedProfit(0.1, notes)).toBe(0);
    });
  });

  describe('noteProfitAdjustment / noteRevenueAdjustment', () => {
    it('ajuste de utilidad: ND − NC de utilidades', () => {
      const notes: NoteTotals = { creditTotal: 30, creditCost: 18, debitTotal: 10, debitCost: 4 };
      // (10−4) − (30−18) = 6 − 12 = −6.
      expect(noteProfitAdjustment(notes).toNumber()).toBe(-6);
    });

    it('ajuste de ventas: ND total − NC total', () => {
      const notes: NoteTotals = { creditTotal: 30, creditCost: 18, debitTotal: 10, debitCost: 4 };
      expect(noteRevenueAdjustment(notes).toNumber()).toBe(-20);
    });
  });

  describe('computeAbonoProfitProportional', () => {
    it('un abono aporta utilidad proporcional (fixture credito_con_abono)', () => {
      // abono 100 sobre factura total 300 / cost 180 → 100 · 120/300 = 40.
      expect(
        computeAbonoProfitProportional([
          { amountPaid: 100, consolidatedTotal: 300, consolidatedCost: 180 },
        ]),
      ).toBe(40);
    });

    it('capa el pago al total (sobrepago no infla la utilidad)', () => {
      // paga 400 de una factura de 300 → effective = 300 → utilidad completa 120.
      expect(
        computeAbonoProfitProportional([
          { amountPaid: 400, consolidatedTotal: 300, consolidatedCost: 180 },
        ]),
      ).toBe(120);
    });

    it('suma varios abonos', () => {
      expect(
        computeAbonoProfitProportional([
          { amountPaid: 100, consolidatedTotal: 300, consolidatedCost: 180 },
          { amountPaid: 50, consolidatedTotal: 100, consolidatedCost: 60 },
        ]),
      ).toBe(60); // 40 + 50·40/100(=20) = 60.
    });

    it('ignora facturas con total ≤ 0', () => {
      expect(
        computeAbonoProfitProportional([
          { amountPaid: 100, consolidatedTotal: 0, consolidatedCost: 0 },
        ]),
      ).toBe(0);
    });

    it('lista vacía = 0', () => {
      expect(computeAbonoProfitProportional([])).toBe(0);
    });
  });
});
