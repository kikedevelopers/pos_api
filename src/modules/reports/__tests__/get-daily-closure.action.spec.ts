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

/**
 * Recaudo de cartera discriminado por edad del crédito. Los abonos GLOBALES
 * (`globalCash`/`globalTransfer`/`globalProfit`) deben ser la suma de los grupos
 * para que reconcilien con `abonosByCreditAge` (así lo garantiza el `GROUP BY`
 * real; aquí lo emulamos coherente en el mock).
 */
interface AbonosScenario {
  cash: { previous: number; today: number };
  transfer: { previous: number; today: number };
  profit: { previous: number; today: number };
  consigDetalle?: { is_today: boolean; bank_name: string; amount: number }[];
  globalCash: number;
  globalTransfer: number;
  globalProfit: number;
}

/** Escenario base de queries: contado bruto 400/costo 300, utilidad cobrada 100. */
interface Scenario {
  grossSales: number;
  grossCost: number;
  collectedProfit: number;
  orders: { total: number; cost: number };
  newCredits?: { count: number; total: number; profit: number; cost: number; balance: number };
  abonos?: AbonosScenario;
  /** Abonos a transportistas del día (`carrier_payments`). Default 0. */
  carrierPayments?: number;
}

const BASE_SCENARIO: Scenario = {
  grossSales: 400,
  grossCost: 300,
  collectedProfit: 100,
  orders: { total: 0, cost: 0 },
};

/**
 * Router de queries por SQL. Devuelve la fila que corresponde a cada agregado;
 * lo no cubierto → `[]` (COALESCE a 0 en el action). Las queries DISCRIMINADAS
 * por edad del crédito se distinguen por la columna `AS is_today`.
 */
function buildQueryMock(scenario: Scenario): jest.Mock {
  const ab = scenario.abonos;
  return jest.fn((sql: string, params?: unknown[]) => {
    const method = params?.[3];
    // ── Queries DISCRIMINADAS por edad del crédito (llevan `AS is_today`) ──
    if (/AS is_today/.test(sql)) {
      // Utilidad cobrada de abonos por grupo (proporcional, lleva note_agg).
      if (/WITH note_agg AS/.test(sql)) {
        return Promise.resolve([
          { is_today: false, amount: ab?.profit.previous ?? 0 },
          { is_today: true, amount: ab?.profit.today ?? 0 },
        ]);
      }
      // Detalle de consignación por banco y grupo.
      if (/bank_name/.test(sql)) {
        return Promise.resolve(ab?.consigDetalle ?? []);
      }
      // Monto de abonos por método ($4) y grupo.
      if (/abonos_total/.test(sql)) {
        const g = method === 'TRANSFER' ? ab?.transfer : ab?.cash;
        return Promise.resolve([
          { is_today: false, abonos_total: g?.previous ?? 0 },
          { is_today: true, abonos_total: g?.today ?? 0 },
        ]);
      }
    }
    // Créditos nuevos del día (fetchNewCredits). Se comprueba ANTES que el
    // collectedProfit porque ambas queries llevan `WITH note_agg AS`; la de
    // créditos se distingue por `AS new_credits_total`.
    if (/AS new_credits_total/.test(sql)) {
      const c = scenario.newCredits;
      return Promise.resolve([
        {
          new_credits_count: c?.count ?? 0,
          new_credits_total: c?.total ?? 0,
          pending_balance: c?.balance ?? 0,
          new_credits_profit: c?.profit ?? 0,
          new_credits_cost: c?.cost ?? 0,
        },
      ]);
    }
    // Utilidad cobrada canónica (financial-facts) SIN agrupar. La variante de
    // ABONOS lleva además un EXISTS sobre sale_credits.
    if (/WITH note_agg AS/.test(sql)) {
      const isAbono = /EXISTS \(\s*SELECT 1 FROM sale_credits/.test(sql);
      return Promise.resolve([
        { amount: isAbono ? (ab?.globalProfit ?? 0) : scenario.collectedProfit },
      ]);
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
    // Abonos GLOBALES sin agrupar (`AS abonos_total`, sin is_today), por método.
    if (/AS abonos_total/.test(sql)) {
      const total = method === 'TRANSFER' ? (ab?.globalTransfer ?? 0) : (ab?.globalCash ?? 0);
      return Promise.resolve([{ abonos_total: total }]);
    }
    // Abonos a transportistas del día (carrier_payments).
    if (/FROM carrier_payments/.test(sql)) {
      return Promise.resolve([{ abonos: scenario.carrierPayments ?? 0 }]);
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
    // Venta directa discriminada: sin crédito ≡ el total del bloque.
    expect(result.directSalesTotal).toBe(400);
    expect(result.directSalesProfit).toBe(100);
    expect(result.directSalesMargin).toBe(25);
    // Headline = utilidad COBRADA canónica pura (100), margen sobre recaudo 400.
    expect(result.profit).toBe(100);
    expect(result.margin).toBe(25);
    // Caja: 400 de contado, sin gastos.
    expect(result.finalTotal).toBe(400);
  });

  // ─── Créditos del día en el bloque "Ventas del Día" ─────────────────────────

  it('crédito del día: entra a salesProfit/salesRevenue (devengado) y se discrimina; la CAJA no cambia', async () => {
    includeOrders = false;
    // Contado 400/300 (util 100) + crédito 200 con ganancia devengada 80.
    const action = buildAction({
      ...BASE_SCENARIO,
      newCredits: { count: 1, total: 200, profit: 80, cost: 120, balance: 200 },
    });
    const result = await action.execute(7, '2026-06-15');

    // Bloque "Ventas del Día" = contado (100) + crédito (80) = 180; base 400+200=600.
    expect(result.salesProfit).toBe(180);
    expect(result.salesMargin).toBe(30); // 180/600
    // Venta directa (contado) discriminada, ANTES del crédito.
    expect(result.directSalesTotal).toBe(400);
    expect(result.directSalesProfit).toBe(100);
    expect(result.directSalesMargin).toBe(25); // 100/400
    // Créditos del día discriminados.
    expect(result.creditsBreakdown.newCreditsTotal).toBe(200);
    expect(result.creditsBreakdown.newCreditsProfit).toBe(80);
    expect(result.creditsBreakdown.newCreditsMargin).toBe(40); // 80/200
    // La descomposición cuadra: venta directa + crédito = total del bloque.
    expect(result.directSalesTotal + result.creditsBreakdown.newCreditsTotal).toBe(600);
    expect(result.directSalesProfit + result.creditsBreakdown.newCreditsProfit).toBe(
      result.salesProfit,
    );
    // Headline CAJA sin cambios: el crédito no se ha cobrado.
    expect(result.profit).toBe(100);
    expect(result.finalTotal).toBe(400);
    expect(result.creditsBreakdown.abonosTotal).toBe(0);
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
    // El pedido es venta directa (no crédito): entra a la venta directa discriminada.
    expect(result.directSalesTotal).toBe(600);
    expect(result.directSalesProfit).toBe(160);
    expect(result.directSalesMargin).toBe(26.67);
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

  // ─── Abonos a transportistas del día (SALIDA de caja informativa) ──────────
  describe('carrierPaymentsTotal', () => {
    it('expone los abonos a transportistas del día', async () => {
      const action = buildAction({ ...BASE_SCENARIO, carrierPayments: 15000 });
      const result = await action.execute(7, '2026-06-15');
      expect(result.carrierPaymentsTotal).toBe(15000);
    });

    it('NO resta de la ganancia ni toca la caja (el flete ya está en el costo)', async () => {
      const action = buildAction({ ...BASE_SCENARIO, carrierPayments: 15000 });
      const result = await action.execute(7, '2026-06-15');
      // Idénticos al escenario base sin transportistas: profit/caja intactos.
      expect(result.profit).toBe(100);
      expect(result.salesProfit).toBe(100);
      expect(result.finalTotal).toBe(400);
    });

    it('día sin pagos a transportistas: 0', async () => {
      const action = buildAction(BASE_SCENARIO);
      const result = await action.execute(7, '2026-06-15');
      expect(result.carrierPaymentsTotal).toBe(0);
    });

    it('multi-tenant: la query de carrier_payments filtra company_id=$1', async () => {
      const action = buildAction({ ...BASE_SCENARIO, carrierPayments: 15000 });
      await action.execute(42, '2026-06-15');
      const call = querySpy.mock.calls.find(([sql]) =>
        /FROM carrier_payments/.test(sql as string),
      ) as [string, unknown[]] | undefined;
      expect(call).toBeDefined();
      expect(call?.[0]).toMatch(/cp\.company_id\s*=\s*\$1/);
      expect(call?.[1]?.[0]).toBe('42');
    });
  });

  // ─── Recaudo de cartera discriminado por edad del crédito ──────────────────
  describe('abonosByCreditAge (días anteriores vs del día)', () => {
    const ABONOS_SCENARIO: Scenario = {
      ...BASE_SCENARIO,
      abonos: {
        // Días anteriores: 30.000 efectivo + 10.000 consignación (Nequi), util 8.000.
        // Del día: 5.000 efectivo, util 1.200.
        cash: { previous: 30000, today: 5000 },
        transfer: { previous: 10000, today: 0 },
        profit: { previous: 8000, today: 1200 },
        consigDetalle: [{ is_today: false, bank_name: 'Nequi', amount: 10000 }],
        globalCash: 35000,
        globalTransfer: 10000,
        globalProfit: 9200,
      },
    };

    it('discrimina cada grupo con su dinero, ganancia y margen', async () => {
      const action = buildAction(ABONOS_SCENARIO);
      const result = await action.execute(7, '2026-06-15');
      const { previous, today } = result.creditsBreakdown.abonosByCreditAge;

      // Días anteriores.
      expect(previous.cash).toBe(30000);
      expect(previous.consignacion).toBe(10000);
      expect(previous.total).toBe(40000);
      expect(previous.profit).toBe(8000);
      expect(previous.margin).toBe(20); // 8.000 / 40.000
      expect(previous.consignacionDetalle).toEqual([{ bankName: 'Nequi', amount: 10000 }]);
      // Del día.
      expect(today.cash).toBe(5000);
      expect(today.consignacion).toBe(0);
      expect(today.total).toBe(5000);
      expect(today.profit).toBe(1200);
      expect(today.margin).toBe(24); // 1.200 / 5.000
      expect(today.consignacionDetalle).toEqual([]);
    });

    it('reconcilia con los globales: previous + today = abonos totales y creditsProfit', async () => {
      const action = buildAction(ABONOS_SCENARIO);
      const result = await action.execute(7, '2026-06-15');
      const { previous, today } = result.creditsBreakdown.abonosByCreditAge;

      expect(result.creditsBreakdown.abonosCash).toBe(35000);
      expect(result.creditsBreakdown.abonosConsignacion).toBe(10000);
      expect(result.creditsBreakdown.abonosTotal).toBe(45000);
      expect(previous.total + today.total).toBe(result.creditsBreakdown.abonosTotal);
      // creditsProfit (RENTABILIDAD global del recaudo) = suma de los grupos.
      expect(result.creditsProfit).toBe(9200);
      expect(previous.profit + today.profit).toBe(result.creditsProfit);
    });

    it('día sin recaudo: ambos grupos en cero, sin dividir por cero', async () => {
      const action = buildAction(BASE_SCENARIO);
      const result = await action.execute(7, '2026-06-15');
      const { previous, today } = result.creditsBreakdown.abonosByCreditAge;

      expect(previous).toEqual({
        cash: 0,
        consignacion: 0,
        consignacionDetalle: [],
        total: 0,
        profit: 0,
        margin: 0,
      });
      expect(today.margin).toBe(0);
      expect(result.creditsBreakdown.abonosTotal).toBe(0);
    });

    it('multi-tenant: las queries por edad filtran company_id=$1 y agrupan por is_today', async () => {
      const action = buildAction(ABONOS_SCENARIO);
      await action.execute(42, '2026-06-15');

      const byAgeCalls = querySpy.mock.calls.filter(([sql]) =>
        /AS is_today/.test(sql as string),
      ) as [string, unknown[]][];
      expect(byAgeCalls.length).toBeGreaterThan(0);
      for (const [sql, params] of byAgeCalls) {
        expect(sql).toMatch(/company_id\s*=\s*\$1/);
        expect(sql).toMatch(/GROUP BY is_today/);
        expect(params[0]).toBe('42');
      }
    });
  });
});
