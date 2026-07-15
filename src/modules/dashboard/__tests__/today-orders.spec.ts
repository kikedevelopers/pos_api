import { computeTodayTotals } from '../internal/today-orders';

/**
 * Totales del resumen del día bajo el flag `include_orders_in_reports`.
 *
 * Escenario base (el reportado por el usuario): venta cobrada de $5.000 con
 * ganancia $1.480 + pedido de $2.500 con ganancia $740.
 */
describe('computeTodayTotals', () => {
  describe('flag ON: el pedido cuenta como una venta normal', () => {
    it('suma la facturación del pedido al total recaudado', () => {
      // El caso reportado: el recaudo debe pasar de 5.000 a 7.500.
      const { totalCollected } = computeTodayTotals({
        collectedCash: 5000,
        ordersTotal: 2500,
        collectedProfit: 1480,
        ordersProfit: 740,
        expenses: 0,
      });

      expect(totalCollected).toBe(7500);
    });

    it('suma la ganancia del pedido a la ganancia del día', () => {
      const { profit } = computeTodayTotals({
        collectedCash: 5000,
        ordersTotal: 2500,
        collectedProfit: 1480,
        ordersProfit: 740,
        expenses: 0,
      });

      expect(profit).toBe(2220);
    });

    it('la ganancia sube por la GANANCIA del pedido, nunca por su total', () => {
      // Regresión: un pedido de 2.500 con ganancia 740 aporta 740, no 2.500.
      const base = { collectedCash: 5000, collectedProfit: 1480, expenses: 0 };
      const sin = computeTodayTotals({ ...base, ordersTotal: 0, ordersProfit: 0 });
      const con = computeTodayTotals({ ...base, ordersTotal: 2500, ordersProfit: 740 });

      expect(con.profit - sin.profit).toBe(740);
    });

    it('el excedente sale de un recaudo que ya incluye el pedido', () => {
      const { surplus } = computeTodayTotals({
        collectedCash: 5000,
        ordersTotal: 2500,
        collectedProfit: 1480,
        ordersProfit: 740,
        expenses: 0,
      });

      expect(surplus).toBe(5280); // 7.500 − 2.220
    });

    it('mantiene la identidad: recaudo = excedente + ganancia', () => {
      const { totalCollected, profit, surplus } = computeTodayTotals({
        collectedCash: 5000,
        ordersTotal: 2500,
        collectedProfit: 1480,
        ordersProfit: 740,
        expenses: 0,
      });

      expect(surplus + profit).toBe(totalCollected);
    });

    it('la ganancia real resta los gastos a la ganancia CON pedidos', () => {
      const { realProfit } = computeTodayTotals({
        collectedCash: 5000,
        ordersTotal: 2500,
        collectedProfit: 1480,
        ordersProfit: 740,
        expenses: 500,
      });

      expect(realProfit).toBe(1720);
    });

    it('un día SOLO de pedidos factura como si fuera una venta', () => {
      const { totalCollected, profit, surplus, realProfit } = computeTodayTotals({
        collectedCash: 0,
        ordersTotal: 2500,
        collectedProfit: 0,
        ordersProfit: 740,
        expenses: 0,
      });

      expect(totalCollected).toBe(2500);
      expect(profit).toBe(740);
      expect(surplus).toBe(1760);
      expect(realProfit).toBe(740);
    });
  });

  describe('flag OFF: reducción exacta al comportamiento previo', () => {
    it('con ordersTotal y ordersProfit en 0 reproduce el cálculo de siempre', () => {
      const { totalCollected, profit, surplus, realProfit } = computeTodayTotals({
        collectedCash: 5000,
        ordersTotal: 0,
        collectedProfit: 1480,
        ordersProfit: 0,
        expenses: 0,
      });

      expect(totalCollected).toBe(5000); // caja pura
      expect(profit).toBe(1480);
      expect(surplus).toBe(3520); // 5.000 − 1.480, el excedente de siempre
      expect(realProfit).toBe(1480);
    });

    it('no altera la ganancia cobrada canónica', () => {
      const { profit } = computeTodayTotals({
        collectedCash: 12345.67,
        ordersTotal: 0,
        collectedProfit: 4321.09,
        ordersProfit: 0,
        expenses: 0,
      });

      expect(profit).toBe(4321.09);
    });
  });

  describe('casos límite', () => {
    it('un día sin movimiento deja todo en cero', () => {
      expect(
        computeTodayTotals({
          collectedCash: 0,
          ordersTotal: 0,
          collectedProfit: 0,
          ordersProfit: 0,
          expenses: 0,
        }),
      ).toEqual({ totalCollected: 0, profit: 0, surplus: 0, realProfit: 0 });
    });

    it('la ganancia real queda negativa si los gastos la superan', () => {
      const { realProfit } = computeTodayTotals({
        collectedCash: 5000,
        ordersTotal: 2500,
        collectedProfit: 1480,
        ordersProfit: 740,
        expenses: 3000,
      });

      expect(realProfit).toBe(-780);
    });

    it('un pedido a pérdida resta ganancia pero suma su total al recaudo', () => {
      const { totalCollected, profit } = computeTodayTotals({
        collectedCash: 5000,
        ordersTotal: 1000,
        collectedProfit: 1480,
        ordersProfit: -200, // se vendió por debajo del costo
        expenses: 0,
      });

      expect(totalCollected).toBe(6000);
      expect(profit).toBe(1280);
    });

    it('redondea a 2 decimales con precisión de dinero (Big.js)', () => {
      // 0.1 + 0.2 en float da 0.30000000000000004.
      const { profit } = computeTodayTotals({
        collectedCash: 0,
        ordersTotal: 0,
        collectedProfit: 0.1,
        ordersProfit: 0.2,
        expenses: 0,
      });

      expect(profit).toBe(0.3);
    });

    it('no arrastra error de coma flotante en el recaudo', () => {
      const { totalCollected } = computeTodayTotals({
        collectedCash: 1000.1,
        ordersTotal: 2000.2,
        collectedProfit: 0,
        ordersProfit: 0,
        expenses: 0,
      });

      expect(totalCollected).toBe(3000.3);
    });
  });
});
