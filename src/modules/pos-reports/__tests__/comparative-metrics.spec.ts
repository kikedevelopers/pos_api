import type { DataSource } from 'typeorm';

import { fetchDayMetricsMap, sumRangeTotals } from '../internal/comparative-metrics';

/**
 * Comparativa en base DEVENGADO: una venta a crédito es una venta más.
 *
 * - `fetchDayMetricsMap` debe leer ventas y notas INCLUYENDO crédito (sin el
 *   filtro `NOT EXISTS sale_credits`) y NO debe sumar el share de abonos (que
 *   doble-contaría el crédito ya reconocido al vender).
 * - La combinación sales/cost/profit y la totalización se prueban con datos.
 */
describe('comparative-metrics (devengado, incluye crédito)', () => {
  const START = new Date('2026-07-01T05:00:00.000Z');
  const END = new Date('2026-08-01T04:59:59.999Z');

  function makeDs(
    sales: Array<{ date: string; sales: number; cost: number; profit: number }>,
    notes: Array<{ date: string; note_type: string; notes_total: number; notes_cost: number }>,
  ): { ds: DataSource; sqls: string[] } {
    const sqls: string[] = [];
    const query = jest.fn((sql: string) => {
      sqls.push(sql);
      if (/FROM sale_invoices/.test(sql) && /SUM\(si\.total\)/.test(sql)) {
        return Promise.resolve(sales);
      }
      // notas
      return Promise.resolve(notes);
    });
    return { ds: { query } as unknown as DataSource, sqls };
  }

  it('lee ventas y notas INCLUYENDO crédito (sin NOT EXISTS sale_credits) y NO consulta abonos', async () => {
    const { ds, sqls } = makeDs([], []);
    await fetchDayMetricsMap(ds, 13, START, END);
    // Exactamente 2 queries: ventas + notas (nada de abonos/creditPayments).
    expect(sqls.length).toBe(2);
    for (const sql of sqls) {
      expect(sql).not.toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM sale_credits/i);
    }
    // Ninguna query debe descomponer abonos (sale_payments · sale_credits).
    expect(sqls.some((s) => /sale_payments/i.test(s))).toBe(false);
  });

  it('suma ventas de contado + crédito por su valor íntegro y netea notas', async () => {
    // Día con una venta de contado (100/60) y una a crédito (200/120) = 300/180.
    const { ds } = makeDs(
      [{ date: '2026-07-10', sales: 300, cost: 180, profit: 120 }],
      // Una NC de 20 (costo 12) resta.
      [{ date: '2026-07-10', note_type: 'CREDIT', notes_total: 20, notes_cost: 12 }],
    );
    const map = await fetchDayMetricsMap(ds, 13, START, END);
    const totals = sumRangeTotals(map, ['2026-07-10']);
    expect(totals.sales).toBe(280); // 300 − 20
    expect(totals.cost).toBe(168); // 180 − 12
    expect(totals.profit).toBe(112); // 120 − 8
    expect(totals.margin).toBe(40); // 112/280*100
  });
});
