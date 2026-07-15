import type { DataSource } from 'typeorm';

import type { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';

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
  // Flag `include_orders_in_reports` de la company (default OFF).
  let includeOrders: boolean;

  beforeEach(() => {
    // Cada query devuelve [] → todos los agregados COALESCE a 0. Suficiente
    // para validar el aislamiento de tenant y el shape (que no depende de
    // valores concretos).
    querySpy = jest.fn(() => Promise.resolve([]));
    includeOrders = false;
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    const getIncludeOrdersMock = {
      execute: jest.fn(() => Promise.resolve({ enabled: includeOrders })),
    } as unknown as GetIncludeOrdersInReportsAction;
    action = new GetExtendedSummaryAction(dataSourceMock, getIncludeOrdersMock);
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
      pedidos: 0,
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

  // ─── Flag include_orders_in_reports: sub-línea ventas.pedidos ───────────────

  it('flag OFF: pedidos=0, NO ejecuta la query de ORDER y total = base cobrada', async () => {
    includeOrders = false;
    const result = await action.execute(42, '2026-06-01', '2026-06-30');
    expect(result.ventas.pedidos).toBe(0);
    expect(result.ventas.total).toBe(0);
    // Con OFF no debe emitirse la query de facturación de pedidos.
    const ordersCall = querySpy.mock.calls.find(([sql]) =>
      /ticket_type = 'ORDER'/.test(sql as string),
    ) as [string, unknown[]] | undefined;
    expect(ordersCall).toBeUndefined();
  });

  it('flag OFF (regresión): ganancia = cobrada canónica y margen sobre la base cobrada', async () => {
    includeOrders = false;
    // Contado bruto 400 (sin notas) y utilidad cobrada canónica 100.
    querySpy.mockImplementation((sql: string) => {
      if (/AS gross_sales/.test(sql)) {
        return Promise.resolve([{ gross_sales: 400, gross_cost: 300 }]);
      }
      if (/WITH note_agg AS/.test(sql)) {
        return Promise.resolve([{ amount: 100 }]);
      }
      return Promise.resolve([]);
    });

    const result = await action.execute(42, '2026-06-01', '2026-06-30');

    expect(result.ventas.pedidos).toBe(0);
    expect(result.ventas.efectivo).toBe(400);
    expect(result.ventas.total).toBe(400);
    // Ganancia = collectedProfit puro, SIN delta de pedidos.
    expect(result.ventas.ganancia).toBe(100);
    // Margen 100/400 = 25%: idéntico al de antes del flag (el total ≡ cobrado).
    expect(result.ventas.margen).toBe(25);
    expect(result.gananciaReal).toBe(100);
  });

  it('flag ON: el pedido se asume COMPLETO — total, ganancia, margen y gananciaReal lo incluyen', async () => {
    includeOrders = true;
    // La query de pedidos (única con ticket_type='ORDER') factura 40 con costo
    // 25 → ganancia REAL del pedido = 15. El resto de agregados quedan en 0.
    querySpy.mockImplementation((sql: string) =>
      Promise.resolve(
        /ticket_type = 'ORDER'/.test(sql) ? [{ orders_total: 40, orders_cost: 25 }] : [],
      ),
    );

    const result = await action.execute(42, '2026-06-01', '2026-06-30');

    // pedidos entra al total…
    expect(result.ventas.pedidos).toBe(40);
    expect(result.ventas.total).toBe(40);
    // …y su ganancia real (40 - 25) se suma a la cobrada (0 aquí).
    expect(result.ventas.ganancia).toBe(15);
    // margen sobre el total, que YA incluye pedidos: 15/40 = 37.5%.
    expect(result.ventas.margen).toBe(37.5);
    // gananciaReal = ganancia (con pedido) - gastos (0).
    expect(result.gananciaReal).toBe(15);
    // El dinero REAL no se contamina: el pedido no se ha cobrado.
    expect(result.ventas.efectivo).toBe(0);
    expect(result.ventas.electronico).toBe(0);
    expect(result.ventas.credito).toBe(0);
  });

  it('flag ON: la ganancia del pedido se SUMA a la cobrada canónica (no la reemplaza)', async () => {
    includeOrders = true;
    // collectedProfit (query canónica de financial-facts) = 100; pedido 40/10 → +30.
    querySpy.mockImplementation((sql: string) => {
      if (/ticket_type = 'ORDER'/.test(sql)) {
        return Promise.resolve([{ orders_total: 40, orders_cost: 10 }]);
      }
      // Query canónica de utilidad cobrada (financial-facts/collection-facts).
      if (/WITH note_agg AS/.test(sql)) {
        return Promise.resolve([{ amount: 100 }]);
      }
      return Promise.resolve([]);
    });

    const result = await action.execute(42, '2026-06-01', '2026-06-30');

    // 100 (cobrada) + 30 (pedido) = 130. NO se toca fetchCollectedProfit.
    expect(result.ventas.ganancia).toBe(130);
    expect(result.gananciaReal).toBe(130);
  });

  it('flag ON con pedido de margen 0: no infla la ganancia (total = costo)', async () => {
    includeOrders = true;
    querySpy.mockImplementation((sql: string) =>
      Promise.resolve(
        /ticket_type = 'ORDER'/.test(sql) ? [{ orders_total: 50, orders_cost: 50 }] : [],
      ),
    );

    const result = await action.execute(42, '2026-06-01', '2026-06-30');

    expect(result.ventas.pedidos).toBe(50);
    expect(result.ventas.total).toBe(50);
    expect(result.ventas.ganancia).toBe(0);
    expect(result.ventas.margen).toBe(0);
  });

  it('flag ON: la query de pedidos filtra company_id=$1 y usa COALESCE(sold_at,created_at)', async () => {
    includeOrders = true;
    querySpy.mockImplementation((sql: string) =>
      Promise.resolve(
        /ticket_type = 'ORDER'/.test(sql) ? [{ orders_total: 10, orders_cost: 4 }] : [],
      ),
    );
    await action.execute(42, '2026-06-01', '2026-06-30');
    const ordersCall = querySpy.mock.calls.find(([sql]) =>
      /ticket_type = 'ORDER'/.test(sql as string),
    ) as [string, unknown[]] | undefined;
    expect(ordersCall).toBeDefined();
    expect(ordersCall?.[0]).toMatch(/si\.company_id\s*=\s*\$1/);
    expect(ordersCall?.[0]).toMatch(/COALESCE\(si\.sold_at,\s*si\.created_at\)\s*BETWEEN/);
    expect(ordersCall?.[0]).toMatch(/si\.is_deleted = false/);
    expect(ordersCall?.[1]?.[0]).toBe('42');
  });
});
