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
      // fetchNewCreditsByCashier (consolidado neto de notas): crédito 200, gan 80.
      if (/AS amount/.test(sql) && /note_agg/.test(sql)) {
        return Promise.resolve([
          { user_id: 7, user_name: 'Ana', count: 1, amount: 200, profit: 80 },
        ]);
      }
      // fetchSalesProfitByCashier (CTE payment_split): utilidad de contado 40
      // (todo en efectivo).
      if (/WITH payment_split AS/.test(sql)) {
        return Promise.resolve([{ user_id: 7, cash_profit: 40, transfer_profit: 0 }]);
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
    // Ganancia y margen POR MÉTODO en el desglose.
    expect(c.cashProfit).toBe(40);
    expect(c.cashMargin).toBe(40); // 40/100
    expect(c.transferProfit).toBe(0);
    expect(c.creditProfit).toBe(80);
    expect(c.creditMargin).toBe(40); // 80/200
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
