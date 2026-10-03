import type { DataSource } from 'typeorm';

import { GetBranchesSummaryAction } from '../actions/get-branches-summary.action';
import type { GetTodayAction, TodayResult } from '../actions/get-today.action';

/**
 * Resumen consolidado por sucursal del owner.
 *
 *   - Fila por negocio principal (SIEMPRE) + sucursales ACTIVAS.
 *   - Sucursal suspendida (company_members.is_active=false) NO aparece.
 *   - Cada fila reutiliza GetTodayAction: sales=totalSales, profit=salesProfit,
 *     margin=profit/sales, expenses=expenses, total=sales−expenses.
 *   - `totals` suma cada columna; el margen total = sumProfit/sumSales.
 */
describe('GetBranchesSummaryAction', () => {
  const OWNER_ID = 42;

  /** Fabrica un TodayResult mínimo con solo los campos que el action consume. */
  function today(partial: Partial<TodayResult>): TodayResult {
    return {
      date: '2026-10-03',
      totalSales: 0,
      salesProfit: 0,
      expenses: 0,
      ...partial,
    } as TodayResult;
  }

  /**
   * Mock del DataSource cuya única query es la de companies del owner. Devuelve
   * las filas que se le pasen.
   */
  function makeDs(companyRows: unknown[]): { ds: DataSource; query: jest.Mock } {
    const query = jest.fn().mockResolvedValue(companyRows);
    return { ds: { query } as unknown as DataSource, query };
  }

  /** Mock de GetTodayAction: mapa companyId → TodayResult. */
  function makeGetToday(byCompany: Record<number, TodayResult>): {
    action: GetTodayAction;
    execute: jest.Mock;
  } {
    const execute = jest.fn((companyId: number) => {
      const result = byCompany[companyId];
      if (!result) {
        throw new Error(`TodayResult no mockeado para company ${companyId}`);
      }
      return Promise.resolve(result);
    });
    return { action: { execute } as unknown as GetTodayAction, execute };
  }

  it('incluye principal + sucursales activas, calcula filas y totales', async () => {
    const { ds, query } = makeDs([
      { id: '10', name: 'Negocio Principal', is_branch: false, is_active: true },
      { id: '20', name: 'Sucursal Centro', is_branch: true, is_active: true },
      { id: '30', name: 'Sucursal Norte', is_branch: true, is_active: true },
    ]);
    const { action: getToday } = makeGetToday({
      10: today({ totalSales: 1000, salesProfit: 400, expenses: 100 }),
      20: today({ totalSales: 500, salesProfit: 150, expenses: 50 }),
      30: today({ totalSales: 300, salesProfit: 90, expenses: 0 }),
    });

    const action = new GetBranchesSummaryAction(ds, getToday);
    const result = await action.execute(OWNER_ID, '2026-10-03');

    // La query de companies filtró por el owner.
    expect(query).toHaveBeenCalledWith(expect.any(String), [String(OWNER_ID)]);

    expect(result.date).toBe('2026-10-03');
    expect(result.rows).toHaveLength(3);

    const [principal, centro, norte] = result.rows;
    expect(principal).toEqual({
      companyId: 10,
      name: 'Negocio Principal',
      isBranch: false,
      sales: 1000,
      profit: 400,
      margin: 40, // 400/1000
      expenses: 100,
      total: 900, // 1000 - 100
    });
    expect(centro.margin).toBe(30); // 150/500
    expect(centro.total).toBe(450); // 500 - 50
    expect(norte.margin).toBe(30); // 90/300
    expect(norte.total).toBe(300); // 300 - 0

    // Totales = suma de cada columna; margen = sumProfit/sumSales.
    expect(result.totals.sales).toBe(1800); // 1000+500+300
    expect(result.totals.profit).toBe(640); // 400+150+90
    expect(result.totals.expenses).toBe(150); // 100+50+0
    expect(result.totals.total).toBe(1650); // 1800 - 150
    expect(result.totals.margin).toBe(35.56); // 640/1800*100 = 35.555… → 35.56
  });

  it('excluye sucursales suspendidas (is_active=false) pero conserva el principal', async () => {
    const { ds } = makeDs([
      { id: '10', name: 'Principal', is_branch: false, is_active: true },
      { id: '20', name: 'Sucursal Activa', is_branch: true, is_active: true },
      { id: '30', name: 'Sucursal Suspendida', is_branch: true, is_active: false },
    ]);
    const { action: getToday, execute } = makeGetToday({
      10: today({ totalSales: 200, salesProfit: 80, expenses: 20 }),
      20: today({ totalSales: 100, salesProfit: 30, expenses: 10 }),
    });

    const action = new GetBranchesSummaryAction(ds, getToday);
    const result = await action.execute(OWNER_ID, '2026-10-03');

    expect(result.rows.map((r) => r.companyId)).toEqual([10, 20]);
    // La sucursal suspendida (30) nunca se consulta.
    expect(execute).not.toHaveBeenCalledWith(30, expect.anything());
    expect(result.totals.sales).toBe(300);
    expect(result.totals.total).toBe(270); // 300 - 30
  });

  it('un owner sin sucursales (o todas suspendidas) devuelve solo el principal', async () => {
    const { ds } = makeDs([
      { id: '10', name: 'Principal', is_branch: false, is_active: true },
      { id: '30', name: 'Suspendida', is_branch: true, is_active: false },
    ]);
    const { action: getToday } = makeGetToday({
      10: today({ totalSales: 500, salesProfit: 200, expenses: 100 }),
    });

    const action = new GetBranchesSummaryAction(ds, getToday);
    const result = await action.execute(OWNER_ID, '2026-10-03');

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].companyId).toBe(10);
    expect(result.totals.sales).toBe(500);
    expect(result.totals.margin).toBe(40); // 200/500
  });

  it('margen = 0 cuando una company no vendió (evita división por cero)', async () => {
    const { ds } = makeDs([
      { id: '10', name: 'Principal', is_branch: false, is_active: true },
    ]);
    const { action: getToday } = makeGetToday({
      10: today({ totalSales: 0, salesProfit: 0, expenses: 50 }),
    });

    const action = new GetBranchesSummaryAction(ds, getToday);
    const result = await action.execute(OWNER_ID, '2026-10-03');

    expect(result.rows[0].margin).toBe(0);
    expect(result.rows[0].total).toBe(-50); // 0 - 50 (día en rojo)
    expect(result.totals.margin).toBe(0);
    expect(result.totals.total).toBe(-50);
  });

  it('propaga la fecha solicitada a GetTodayAction para cada company', async () => {
    const { ds } = makeDs([
      { id: '10', name: 'Principal', is_branch: false, is_active: true },
      { id: '20', name: 'Sucursal', is_branch: true, is_active: true },
    ]);
    const { action: getToday, execute } = makeGetToday({
      10: today({ totalSales: 10, salesProfit: 1, expenses: 0 }),
      20: today({ totalSales: 20, salesProfit: 2, expenses: 0 }),
    });

    const action = new GetBranchesSummaryAction(ds, getToday);
    await action.execute(OWNER_ID, '2026-09-01');

    expect(execute).toHaveBeenCalledWith(10, '2026-09-01');
    expect(execute).toHaveBeenCalledWith(20, '2026-09-01');
  });
});
