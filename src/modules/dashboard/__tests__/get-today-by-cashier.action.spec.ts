import type { DataSource } from 'typeorm';

import { GetTodayByCashierAction } from '../actions/get-today-by-cashier.action';

/**
 * Resumen por cajero en base VENTAS: una venta a crédito es una venta más.
 *
 *   - `totalSales` = contado (efectivo+consignación) + crédito DEVENGADO.
 *   - `profit`     = utilidad de contado + utilidad devengada del crédito
 *                    (NO la de abonos: eso es cartera).
 *   - `creditSales` discriminado; los abonos (creditPayments*) quedan aparte y
 *     NO entran a totalSales (sin doble conteo).
 */
describe('GetTodayByCashierAction (base ventas, incluye crédito)', () => {
  function makeDs(): DataSource {
    // Router por SQL: cada agregación se identifica por un fragmento único.
    const query = jest.fn((sql: string) => {
      // fetchNotesByCashier (único con CTE note_costs) → sin notas.
      if (/WITH note_costs AS/.test(sql)) {
        return Promise.resolve([]);
      }
      // fetchNewCreditsByCashier: cajero 7 generó crédito 200 con ganancia 80.
      if (/SUM\(si\.profit \* sc\.total_amount/.test(sql)) {
        return Promise.resolve([
          { user_id: 7, user_name: 'Ana', count: 1, amount: 200, profit: 80 },
        ]);
      }
      // fetchSalesProfitByCashier: utilidad de contado 40.
      if (/SUM\(si\.profit\), 0\)::float AS profit_total/.test(sql)) {
        return Promise.resolve([{ user_id: 7, profit_total: 40 }]);
      }
      // fetchSalesCountByCashier.
      if (/COUNT\(\*\)::int AS count/.test(sql)) {
        return Promise.resolve([{ user_id: 7, count: 2 }]);
      }
      // fetchSalesByCashier (agrupa por si.created_by_id): contado efectivo 100.
      if (/GROUP BY si\.created_by_id, user_name/.test(sql)) {
        return Promise.resolve([
          { user_id: 7, user_name: 'Ana', cash_total: 100, transfer_total: 0 },
        ]);
      }
      // fetchAbonosByCashier (agrupa por sp.created_by_id): abono efectivo 30.
      if (/GROUP BY sp\.created_by_id, user_name/.test(sql)) {
        return Promise.resolve([
          { user_id: 7, user_name: 'Ana', cash_total: 30, transfer_total: 0 },
        ]);
      }
      return Promise.resolve([]);
    });
    return { query } as unknown as DataSource;
  }

  it('el crédito entra a Total Ventas y a la ganancia; los abonos quedan aparte', async () => {
    const action = new GetTodayByCashierAction(makeDs());
    const result = await action.execute(42, '2026-07-15');

    expect(result.cashiers).toHaveLength(1);
    const c = result.cashiers[0];
    // Total Ventas = 100 (efectivo) + 0 (consig) + 200 (crédito) = 300.
    expect(c.cashSales).toBe(100);
    expect(c.creditSales).toBe(200);
    expect(c.totalSales).toBe(300);
    // Ganancia devengada = 40 (contado) + 80 (crédito). Los abonos NO aportan ganancia.
    expect(c.profit).toBe(120);
    expect(c.margin).toBe(40); // 120/300
    expect(c.surplus).toBe(180); // 300 - 120
    // Abonos (Recaudo de cartera) discriminados, NO en totalSales.
    expect(c.creditPaymentsCash).toBe(30);
    expect(c.creditPaymentsTotal).toBe(30);
    // Créditos generados (informativo) y conteo de ventas.
    expect(c.newCredits).toEqual({ count: 1, total: 200 });
    expect(c.salesCount).toBe(2);
  });

  it('totals consolida totalSales y ganancia devengada', async () => {
    const action = new GetTodayByCashierAction(makeDs());
    const { totals } = await action.execute(42, '2026-07-15');
    expect(totals.totalSales).toBe(300);
    expect(totals.creditSales).toBe(200);
    expect(totals.profit).toBe(120);
    expect(totals.creditPaymentsTotal).toBe(30);
  });
});
