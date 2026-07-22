import type { DataSource } from 'typeorm';

import { GetSalesByHourAction } from '../actions/get-sales-by-hour.action';

/**
 * Tests unitarios de `GetSalesByHourAction` (venta del día por hora, hora
 * Colombia). Foco: zero-fill a 24 horas, totales agregados y aislamiento
 * multi-tenant (company_id = $1).
 */
describe('GetSalesByHourAction', () => {
  const buildAction = (rows: { hour: number; total: number; count: number }[]) => {
    const querySpy: jest.Mock = jest.fn(() => Promise.resolve(rows));
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    return { action: new GetSalesByHourAction(dataSourceMock), querySpy };
  };

  it('siempre devuelve 24 horas (0–23) con zero-fill y ordenadas', async () => {
    const { action } = buildAction([
      { hour: 9, total: 228900, count: 3 },
      { hour: 14, total: 50000, count: 1 },
    ]);
    const result = await action.execute(13, '2026-07-22');

    expect(result.hours).toHaveLength(24);
    expect(result.hours.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(result.hours[9]).toEqual({ hour: 9, total: 228900, count: 3 });
    expect(result.hours[14]).toEqual({ hour: 14, total: 50000, count: 1 });
    // Una hora sin ventas queda en cero, no ausente.
    expect(result.hours[0]).toEqual({ hour: 0, total: 0, count: 0 });
    expect(result.hours[23]).toEqual({ hour: 23, total: 0, count: 0 });
  });

  it('agrega el total y el conteo del día', async () => {
    const { action } = buildAction([
      { hour: 9, total: 228900, count: 3 },
      { hour: 14, total: 50000, count: 1 },
    ]);
    const result = await action.execute(13, '2026-07-22');
    expect(result.total).toBe(278900);
    expect(result.count).toBe(4);
    expect(result.date).toBe('2026-07-22');
  });

  it('día sin ventas: 24 horas en cero, total y conteo 0', async () => {
    const { action } = buildAction([]);
    const result = await action.execute(13, '2026-07-22');
    expect(result.total).toBe(0);
    expect(result.count).toBe(0);
    expect(result.hours.every((h) => h.total === 0 && h.count === 0)).toBe(true);
  });

  it('multi-tenant: filtra company_id=$1 (stringificado) y la hora en zona Colombia', async () => {
    const { action, querySpy } = buildAction([{ hour: 9, total: 100, count: 1 }]);
    await action.execute(42, '2026-07-22');

    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/si\.company_id\s*=\s*\$1/);
    expect(sql).toMatch(/ticket_type\s*=\s*'SALE'/);
    expect(sql).toMatch(/is_deleted\s*=\s*false/);
    expect(sql).toMatch(/America\/Bogota/);
    expect(params[0]).toBe('42');
  });
});
