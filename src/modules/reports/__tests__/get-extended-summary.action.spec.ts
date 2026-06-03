import type { DataSource } from 'typeorm';

import { GetExtendedSummaryAction } from '../actions/get-extended-summary.action';

/**
 * Tests unitarios de `GetExtendedSummaryAction`.
 *
 * Foco:
 *   1. AISLAMIENTO multi-tenant: TODAS las queries reciben companyId como $1.
 *   2. SHAPE del contrato de respuesta (secciones y subcampos exactos).
 *   3. Defaults de rango (from = primer día del mes, to = hoy) en hora Colombia.
 */
describe('GetExtendedSummaryAction', () => {
  let action: GetExtendedSummaryAction;
  let querySpy: jest.Mock;

  beforeEach(() => {
    // Cada query devuelve [] → todos los agregados COALESCE a 0. Suficiente
    // para validar el aislamiento de tenant y el shape (que no depende de
    // valores concretos).
    querySpy = jest.fn(() => Promise.resolve([]));
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    action = new GetExtendedSummaryAction(dataSourceMock);
  });

  it('multi-tenant: el primer parámetro de TODA query es el companyId stringificado', async () => {
    await action.execute(42, '2026-06-01', '2026-06-30');
    expect(querySpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of querySpy.mock.calls) {
      const [sql, params] = call as [string, unknown[]];
      // Cada query filtra company_id por $1.
      expect(sql).toMatch(/company_id\s*=\s*\$1/);
      expect(params[0]).toBe('42');
      // No debe existir un company_id ligado a un placeholder distinto de $1.
      const matches = sql.match(/company_id\s*=\s*\$\d+/g) ?? [];
      for (const m of matches) {
        expect(m).toMatch(/company_id\s*=\s*\$1/);
      }
    }
  });

  it('devuelve el shape EXACTO del contrato con dinero redondeado a número', async () => {
    const result = await action.execute(7, '2026-06-01', '2026-06-30');

    expect(result.from).toBe('2026-06-01');
    expect(result.to).toBe('2026-06-30');

    expect(result.ventas).toEqual({
      efectivo: 0,
      electronico: 0,
      credito: 0,
      total: 0,
      ganancia: 0,
      margen: 0,
    });
    expect(result.gastos).toEqual({ total: 0 });
    expect(result.gananciaReal).toBe(0);
    expect(result.cartera).toEqual({ balance: 0, count: 0 });

    expect(result.compras).toEqual({
      total: 0,
      saldosPorPagar: 0,
      pagosElectronicos: 0,
      pagosEfectivo: 0,
      recibidas: { count: 0, total: 0 },
      noRecibidas: { count: 0, total: 0 },
      abonosTransportistas: 0,
      abonosTransportistasPendientes: 0,
    });

    expect(result.cajas).toEqual({
      registros: [],
      bancos: [],
      wallets: [],
      totales: { cajas: 0, bancos: 0, wallets: 0, total: 0 },
    });
  });

  it('saldosPorPagar y abonosTransportistasPendientes son point-in-time (sin params de rango)', async () => {
    await action.execute(99, '2026-06-01', '2026-06-30');
    const saldosCall = querySpy.mock.calls.find(([sql]) =>
      /FROM purchase_credits/.test(sql as string),
    ) as [string, unknown[]] | undefined;
    const pendientesCall = querySpy.mock.calls.find(([sql]) =>
      /SUM\(p\.transport_cost\)/.test(sql as string),
    ) as [string, unknown[]] | undefined;

    expect(saldosCall).toBeDefined();
    expect(pendientesCall).toBeDefined();
    // Solo reciben company_id, sin rango de fechas.
    expect(saldosCall?.[1]).toEqual(['99']);
    expect(pendientesCall?.[1]).toEqual(['99']);
  });

  it('aplica defaults de rango cuando faltan from/to (Colombia)', async () => {
    const result = await action.execute(1);
    // from = primer día del mes actual; to = hoy. Validamos formato y from = -01.
    expect(result.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(result.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.to >= result.from).toBe(true);
  });
});
