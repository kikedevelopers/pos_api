import type { DataSource } from 'typeorm';

import type { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';

import { GetDailyClosureAction } from '../actions/get-daily-closure.action';

/**
 * Tests unitarios de `GetDailyClosureAction`.
 *
 * Foco: el flag `include_orders_in_reports` (Fase 2 — "el pedido se asume
 * COMPLETO"):
 *
 *   - OFF (default): `ordersTotal = 0`, la query de ORDER ni se emite y TODAS
 *     las cifras quedan idénticas a las de siempre (regresión).
 *   - ON: `ordersTotal` presente; `profit`/`margin` y `salesProfit`/`salesMargin`
 *     incorporan la ganancia REAL del pedido (total - costo)…
 *   - …pero la CAJA (`finalTotal`, `cashSalesTotal`, `consignacionesVentas`,
 *     abonos) NO cambia NUNCA: un pedido no cobrado no entra a caja.
 *
 * Además: aislamiento multi-tenant (company_id = $1 en toda query).
 */

/** Escenario base de queries: contado bruto 400/costo 300, utilidad cobrada 100. */
interface Scenario {
  grossSales: number;
  grossCost: number;
  collectedProfit: number;
  orders: { total: number; cost: number };
}

const BASE_SCENARIO: Scenario = {
  grossSales: 400,
  grossCost: 300,
  collectedProfit: 100,
  orders: { total: 0, cost: 0 },
};

/**
 * Router de queries por SQL. Devuelve la fila que corresponde a cada agregado;
 * lo no cubierto → `[]` (COALESCE a 0 en el action).
 */
function buildQueryMock(scenario: Scenario): jest.Mock {
  return jest.fn((sql: string) => {
    // Utilidad cobrada canónica (financial-facts). La variante de ABONOS lleva
    // además un EXISTS sobre sale_credits; aquí la dejamos en 0.
    if (/WITH note_agg AS/.test(sql)) {
      return Promise.resolve(
        /FROM sale_credits/.test(sql) ? [{ amount: 0 }] : [{ amount: scenario.collectedProfit }],
      );
    }
    if (/AS gross_sales/.test(sql)) {
      return Promise.resolve([
        { gross_sales: scenario.grossSales, gross_cost: scenario.grossCost },
      ]);
    }
    if (/ticket_type = 'ORDER'/.test(sql)) {
      return Promise.resolve([
        { orders_total: scenario.orders.total, orders_cost: scenario.orders.cost },
      ]);
    }
    return Promise.resolve([]);
  });
}

describe('GetDailyClosureAction', () => {
  let querySpy: jest.Mock;
  let includeOrders: boolean;

  const buildAction = (scenario: Scenario = BASE_SCENARIO): GetDailyClosureAction => {
    querySpy = buildQueryMock(scenario);
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    const getIncludeOrdersMock = {
      execute: jest.fn(() => Promise.resolve({ enabled: includeOrders })),
    } as unknown as GetIncludeOrdersInReportsAction;
    return new GetDailyClosureAction(dataSourceMock, getIncludeOrdersMock);
  };

  beforeEach(() => {
    includeOrders = false;
  });

  const findOrdersCall = (): [string, unknown[]] | undefined =>
    querySpy.mock.calls.find(([sql]) => /ticket_type = 'ORDER'/.test(sql as string)) as
      | [string, unknown[]]
      | undefined;

  // ─── Invariantes generales ─────────────────────────────────────────────────

  it('multi-tenant: el primer parámetro de TODA query es el companyId stringificado', async () => {
    includeOrders = true;
    const action = buildAction({ ...BASE_SCENARIO, orders: { total: 200, cost: 140 } });
    await action.execute(42, '2026-06-15');

    expect(querySpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of querySpy.mock.calls) {
      const [sql, params] = call as [string, unknown[]];
      expect(sql).toMatch(/company_id\s*=\s*\$1/);
      expect(params[0]).toBe('42');
      const matches = sql.match(/company_id\s*=\s*\$\d+/g) ?? [];
      for (const m of matches) {
        expect(m).toMatch(/company_id\s*=\s*\$1/);
      }
    }
  });

  // ─── Flag OFF: regresión, todo idéntico ────────────────────────────────────

  it('flag OFF: ordersTotal=0 y NO se emite la query de pedidos', async () => {
    includeOrders = false;
    const action = buildAction();
    const result = await action.execute(7, '2026-06-15');

    expect(result.ordersTotal).toBe(0);
    expect(findOrdersCall()).toBeUndefined();
  });

  it('flag OFF: profit/margin y salesProfit/salesMargin quedan como siempre', async () => {
    includeOrders = false;
    const action = buildAction();
    const result = await action.execute(7, '2026-06-15');

    // Ventas: contado neto 400, utilidad 400-300 = 100 → margen 25%.
    expect(result.cashSalesTotal).toBe(400);
    expect(result.salesProfit).toBe(100);
    expect(result.salesMargin).toBe(25);
    // Headline = utilidad COBRADA canónica pura (100), margen sobre recaudo 400.
    expect(result.profit).toBe(100);
    expect(result.margin).toBe(25);
    // Caja: 400 de contado, sin gastos.
    expect(result.finalTotal).toBe(400);
  });

  // ─── Flag ON: el pedido se asume COMPLETO ──────────────────────────────────

  it('flag ON: ordersTotal presente y profit/margin incluyen la ganancia REAL del pedido', async () => {
    includeOrders = true;
    // Pedido de 200 con costo 140 → ganancia real 60.
    const action = buildAction({ ...BASE_SCENARIO, orders: { total: 200, cost: 140 } });
    const result = await action.execute(7, '2026-06-15');

    expect(result.ordersTotal).toBe(200);
    // salesProfit = 100 (contado) + 60 (pedido); denominador 400 + 200 = 600.
    expect(result.salesProfit).toBe(160);
    expect(result.salesMargin).toBe(26.67);
    // Headline = 100 (cobrada canónica) + 60 (pedido); recaudo 400 + pedido 200.
    expect(result.profit).toBe(160);
    expect(result.margin).toBe(26.67);
  });

  it('flag ON: la CAJA no se mueve (finalTotal/cashSalesTotal/consignaciones/abonos)', async () => {
    includeOrders = true;
    const action = buildAction({ ...BASE_SCENARIO, orders: { total: 200, cost: 140 } });
    const result = await action.execute(7, '2026-06-15');

    // Idénticos al escenario OFF: el pedido no está cobrado.
    expect(result.finalTotal).toBe(400);
    expect(result.cashSalesTotal).toBe(400);
    expect(result.consignacionesVentas).toBe(0);
    expect(result.creditsBreakdown.abonosTotal).toBe(0);
    expect(result.creditsBreakdown.abonosCash).toBe(0);
    expect(result.creditsBreakdown.abonosConsignacion).toBe(0);
    expect(result.salesBreakdown.netSales).toBe(400);
  });

  it('flag ON: la ganancia del pedido se SUMA a la cobrada canónica (no la reemplaza)', async () => {
    includeOrders = true;
    // Sin ventas de contado: solo el pedido (200/140 → 60) y cobrada canónica 0.
    const action = buildAction({
      grossSales: 0,
      grossCost: 0,
      collectedProfit: 0,
      orders: { total: 200, cost: 140 },
    });
    const result = await action.execute(7, '2026-06-15');

    expect(result.profit).toBe(60);
    // Margen 60/200 = 30% (el único ingreso asumido es el pedido).
    expect(result.margin).toBe(30);
    expect(result.salesProfit).toBe(60);
    expect(result.salesMargin).toBe(30);
    // La caja sigue en cero: nada se cobró.
    expect(result.finalTotal).toBe(0);
    expect(result.cashSalesTotal).toBe(0);
  });

  it('flag ON con pedido de margen 0: suma facturación pero NO ganancia', async () => {
    includeOrders = true;
    const action = buildAction({ ...BASE_SCENARIO, orders: { total: 100, cost: 100 } });
    const result = await action.execute(7, '2026-06-15');

    expect(result.ordersTotal).toBe(100);
    // Ganancia intacta (100), pero el denominador crece → margen baja: 100/500.
    expect(result.profit).toBe(100);
    expect(result.margin).toBe(20);
    expect(result.salesProfit).toBe(100);
    expect(result.salesMargin).toBe(20);
  });

  it('flag ON sin pedidos en el día: cifras idénticas al flag OFF', async () => {
    includeOrders = true;
    const action = buildAction({ ...BASE_SCENARIO, orders: { total: 0, cost: 0 } });
    const result = await action.execute(7, '2026-06-15');

    expect(result.ordersTotal).toBe(0);
    expect(result.profit).toBe(100);
    expect(result.margin).toBe(25);
    expect(result.salesProfit).toBe(100);
    expect(result.salesMargin).toBe(25);
    expect(result.finalTotal).toBe(400);
  });

  it('flag ON: la query de pedidos filtra ORDER vivos por COALESCE(sold_at,created_at) y company_id=$1', async () => {
    includeOrders = true;
    const action = buildAction({ ...BASE_SCENARIO, orders: { total: 200, cost: 140 } });
    await action.execute(42, '2026-06-15');

    const ordersCall = findOrdersCall();
    expect(ordersCall).toBeDefined();
    expect(ordersCall?.[0]).toMatch(/si\.company_id\s*=\s*\$1/);
    expect(ordersCall?.[0]).toMatch(/si\.is_deleted = false/);
    expect(ordersCall?.[0]).toMatch(/COALESCE\(si\.sold_at,\s*si\.created_at\)\s*BETWEEN/);
    // Trae total Y costo: sin el costo no habría ganancia real del pedido.
    expect(ordersCall?.[0]).toMatch(/SUM\(si\.total\)/);
    expect(ordersCall?.[0]).toMatch(/SUM\(si\.cost\)/);
    expect(ordersCall?.[1]?.[0]).toBe('42');
  });
});
