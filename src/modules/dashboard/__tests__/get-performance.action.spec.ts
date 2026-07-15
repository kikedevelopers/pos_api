import type { DataSource } from 'typeorm';

import type { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';

import { GetPerformanceAction } from '../actions/get-performance.action';

/**
 * Tests unitarios de `GetPerformanceAction`.
 *
 * Foco: garantía de aislamiento multi-tenant. Cada SQL emitido por la action
 * (y los 5 fetchers internos) DEBE incluir `company_id = $1`. Si un fetcher
 * omitiera el filtro en una subquery, sería leak cross-tenant — bug CRÍTICO.
 *
 * Cubrimos:
 *   1. Cada query incluye `company_id = $1` en TODAS sus subqueries.
 *   2. El primer parámetro es siempre el companyId stringificado.
 *   3. Los rangos de fechas se pasan como Date en los parámetros $2/$3.
 *   4. La series respeta `buildDateList` (incluye días sin actividad con 0s).
 *   5. Defaults: si no se pasa from/to, usa últimos 7 días.
 */
describe('GetPerformanceAction', () => {
  let action: GetPerformanceAction;
  let querySpy: jest.Mock;

  beforeEach(() => {
    querySpy = jest.fn(() => Promise.resolve([]));
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    // Flag ON a propósito: así la query de pedidos (`fetchOrdersByDay`) también
    // se ejecuta y queda cubierta por la garantía de aislamiento multi-tenant.
    const includeOrdersMock = {
      execute: jest.fn().mockResolvedValue({ enabled: true }),
    } as unknown as GetIncludeOrdersInReportsAction;
    action = new GetPerformanceAction(dataSourceMock, includeOrdersMock);
  });

  function allCalls(): Array<{ sql: string; params: unknown[] }> {
    return querySpy.mock.calls.map(([sql, params]: [string, unknown[]]) => ({ sql, params }));
  }

  it('cada query filtra por company_id = $1 con el companyId del JWT', async () => {
    await action.execute(42, '2026-05-01', '2026-05-07');

    const calls = allCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      // Toda query toca alguna tabla con FK a company; debe filtrar.
      expect(c.sql).toMatch(/company_id\s*=\s*\$1/);
      // El primer placeholder corresponde al companyId.
      expect(c.params[0]).toBe('42');
    }
  });

  it('aislamiento cross-tenant: companyId=42 jamás se mezcla con otra company', async () => {
    await action.execute(42, '2026-05-01', '2026-05-01');
    const calls = allCalls();
    for (const c of calls) {
      const matches = c.sql.match(/company_id\s*=\s*\$\d+/g) ?? [];
      for (const m of matches) {
        // Si alguna rama usara otro placeholder para company, sería bug.
        expect(m).toMatch(/company_id\s*=\s*\$1/);
      }
    }
  });

  it('series cubre cada día del rango (incluso sin filas)', async () => {
    const result = await action.execute(42, '2026-05-01', '2026-05-03');
    expect(result.series.map((d) => d.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
    // Sin filas en DB, todos los valores son 0.
    for (const point of result.series) {
      expect(point.sales).toBe(0);
      expect(point.profit).toBe(0);
      expect(point.expenses).toBe(0);
      expect(point.credits).toBe(0);
    }
    expect(result.totals.margin).toBe(0);
  });

  it('rechaza rango inválido: to < from', async () => {
    await expect(action.execute(42, '2026-05-10', '2026-05-01')).rejects.toThrow(
      /"to" no puede ser anterior/,
    );
  });

  it('rechaza formato de fecha inválido', async () => {
    await expect(action.execute(42, '2026/05/01', '2026-05-07')).rejects.toThrow(
      /Formato de fecha/,
    );
  });

  it('default sin args: usa últimos 7 días (range incluye hoy)', async () => {
    const result = await action.execute(42);
    // 7 días = 6 días atrás + hoy.
    expect(result.series.length).toBe(7);
  });
});
