import type { DataSource } from 'typeorm';

import { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import { GetBreakEvenProgressAction } from '@/modules/dashboard/actions/get-break-even-progress.action';
import { GetPerformanceAction } from '@/modules/dashboard/actions/get-performance.action';
import { GetTodayAction } from '@/modules/dashboard/actions/get-today.action';
import { Company } from '@/modules/companies/entities/company.entity';
import { GetDailyClosureAction } from '@/modules/reports/actions/get-daily-closure.action';
import { GetExtendedSummaryAction } from '@/modules/reports/actions/get-extended-summary.action';

import { cleanupCompany, createDisposableCompany, tryInitDataSource } from './helpers/e2e-db';

/**
 * E2E (BD REAL) — LA COMPUERTA DEL FLAG `include_orders_in_reports`.
 *
 * Los unitarios prueban las FÓRMULAS (`computeTodayTotals`, `computeVentasTotals`,
 * ...) pasándoles `ordersTotal = 0` a mano. Eso NO prueba el cableado: que el
 * action LEA el flag de `app_settings` y realmente deje de contar los pedidos.
 * Un action que ignorase el flag pasaría todos los unitarios.
 *
 * Aquí se ejercita el flag REAL (fila en `app_settings`, leída por
 * `GetIncludeOrdersInReportsAction`) contra datos REALES, sobre los MISMOS
 * registros, en los 5 endpoints que lo consumen:
 *
 *   1. `/dashboard/today`               → resumen del día + descomposición
 *   2. `/dashboard/break-even-progress` → "Ganancia real hoy" / meta del mes
 *   3. `/dashboard/performance`         → gráfico Rendimiento
 *   4. `/reports/daily-closure`         → Resumen del día (Finanzas)
 *   5. `/reports/extended-summary`      → Resumen extendido (Finanzas)
 *
 * Escenario: venta COBRADA de $5.000 (costo 3.520 → ganancia 1.480) + pedido de
 * $2.500 (costo 1.760 → ganancia 740). Espejo del caso real reportado.
 *
 * Fecha fija (Colombia) 2026-03-15; 15:00Z = 10:00 Colombia, dentro del día.
 */

let seq = 0;

async function insertPaidSale(
  db: DataSource,
  companyId: number,
  opts: { total: number; cost: number; profit: number; at: string },
): Promise<void> {
  seq += 1;
  const suffix = `${Date.now()}-${seq}`;
  const r = await db.query(
    `INSERT INTO sale_invoices
       (company_id, ticket_type, ticket_number, sale_number, total, cost, profit,
        is_deleted, sold_at, created_at, updated_at)
     VALUES ($1, 'SALE', $2, $3, $4, $5, $6, false, $7, $7, $7)
     RETURNING id`,
    [
      String(companyId),
      `E2E-GATE-T-${suffix}`,
      `E2E-GATE-V-${suffix}`,
      opts.total,
      opts.cost,
      opts.profit,
      opts.at,
    ],
  );
  await db.query(
    `INSERT INTO sale_payments
       (company_id, sale_invoice_id, payment_method, amount, change_amount,
        account_type, account_id, is_voided, created_at)
     VALUES ($1, $2, 'CASH'::payment_method, $3, 0, 'cash_register', 1, false, $4)`,
    [String(companyId), r[0].id, opts.total, opts.at],
  );
}

/** Pedido vivo: ticket_type='ORDER', sin `sale_number` y sin pagos. */
async function insertOrder(
  db: DataSource,
  companyId: number,
  opts: { total: number; cost: number; profit: number; at: string },
): Promise<void> {
  seq += 1;
  await db.query(
    `INSERT INTO sale_invoices
       (company_id, ticket_type, ticket_number, total, cost, profit,
        is_deleted, sold_at, created_at, updated_at)
     VALUES ($1, 'ORDER', $2, $3, $4, $5, false, $6, $6, $6)`,
    [
      String(companyId),
      `E2E-GATE-P-${Date.now()}-${seq}`,
      opts.total,
      opts.cost,
      opts.profit,
      opts.at,
    ],
  );
}

describe('Compuerta del flag include_orders_in_reports (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;

  let today: GetTodayAction;
  let breakEven: GetBreakEvenProgressAction;
  let performance: GetPerformanceAction;
  let closure: GetDailyClosureAction;
  let extended: GetExtendedSummaryAction;

  const DAY = '2026-03-15';
  const AT = '2026-03-15T15:00:00.000Z';

  // Datos del escenario.
  const SALE = { total: 5000, cost: 3520, profit: 1480 };
  const ORDER = { total: 2500, cost: 1760, profit: 740 };

  /** Escribe el flag REAL en `app_settings` (lo que hace el toggle de la UI). */
  const setFlag = async (enabled: boolean): Promise<void> => {
    await ds!.query(
      `INSERT INTO app_settings (company_id, key, value)
       VALUES ($1, 'include_orders_in_reports', $2)
       ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [String(companyId), enabled ? 'true' : 'false'],
    );
  };

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      return;
    }
    companyId = await createDisposableCompany(ds, '__e2e_orders_flag_gate');

    // Meta configurada: sin ella el break-even devuelve `configured: false`.
    await ds.query(
      `UPDATE companies SET break_even_amount = 1000000, break_even_period_days = 30 WHERE id = $1`,
      [String(companyId)],
    );

    // Actions REALES, con el lector REAL del flag (nada de stubs: eso es el test).
    const flagReader = new GetIncludeOrdersInReportsAction(ds);
    today = new GetTodayAction(ds, flagReader);
    breakEven = new GetBreakEvenProgressAction(ds, ds.getRepository(Company), flagReader);
    performance = new GetPerformanceAction(ds, flagReader);
    closure = new GetDailyClosureAction(ds, flagReader);
    extended = new GetExtendedSummaryAction(ds, flagReader);

    await insertPaidSale(ds, companyId, { ...SALE, at: AT });
    await insertOrder(ds, companyId, { ...ORDER, at: AT });
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    await ds.query(`DELETE FROM sale_payments WHERE company_id = $1`, [String(companyId)]);
    await ds.query(`DELETE FROM sale_invoices WHERE company_id = $1`, [String(companyId)]);
    await cleanupCompany(ds, companyId);
    await ds.destroy();
  });

  const maybe = (name: string, fn: () => Promise<void>): void =>
    void it(name, async () => {
      if (!ds) {
        console.warn('pos_db no disponible — test omitido');
        return;
      }
      await fn();
    });

  // ─── 1. /dashboard/today ────────────────────────────────────────────────

  maybe('today: ON suma el pedido al recaudo y a la ganancia; OFF no lo cuenta', async () => {
    await setFlag(true);
    const on = await today.execute(companyId, DAY);
    expect(on.ordersTotal).toBe(ORDER.total);
    expect(on.totalCollected).toBe(SALE.total + ORDER.total); // 7.500
    expect(on.profit).toBe(SALE.profit + ORDER.profit); // 2.220
    expect(on.surplus).toBe(5280); // 7.500 − 2.220
    expect(on.realProfit).toBe(2220);

    await setFlag(false);
    const off = await today.execute(companyId, DAY);
    expect(off.ordersTotal).toBe(0);
    expect(off.totalCollected).toBe(SALE.total); // 5.000, caja pura
    expect(off.profit).toBe(SALE.profit); // 1.480
    expect(off.surplus).toBe(3520); // 5.000 − 1.480
    expect(off.realProfit).toBe(1480);
  });

  // ─── 2. /dashboard/break-even-progress ──────────────────────────────────

  maybe('break-even: ON cuenta la ganancia del pedido en la meta; OFF no', async () => {
    await setFlag(true);
    const on = await breakEven.execute(companyId, DAY);
    expect(on.dayRealProfit).toBe(SALE.profit + ORDER.profit); // 2.220

    await setFlag(false);
    const off = await breakEven.execute(companyId, DAY);
    expect(off.dayRealProfit).toBe(SALE.profit); // 1.480
  });

  // ─── 3. /dashboard/performance ──────────────────────────────────────────

  maybe('performance: ON suma el pedido a la serie Recaudo y a Ganancia; OFF no', async () => {
    await setFlag(true);
    const on = await performance.execute(companyId, DAY, DAY);
    expect(on.totals.orders).toBe(ORDER.total);
    expect(on.totals.sales).toBe(SALE.total + ORDER.total);
    expect(on.totals.profit).toBe(SALE.profit + ORDER.profit);

    await setFlag(false);
    const off = await performance.execute(companyId, DAY, DAY);
    expect(off.totals.orders).toBe(0);
    expect(off.totals.sales).toBe(SALE.total);
    expect(off.totals.profit).toBe(SALE.profit);
  });

  // ─── 4. /reports/daily-closure ──────────────────────────────────────────

  maybe('cierre diario: ON suma el pedido a ingresos y ganancia; OFF no', async () => {
    await setFlag(true);
    const on = await closure.execute(companyId, DAY);
    expect(on.ordersTotal).toBe(ORDER.total);
    expect(on.salesProfit).toBe(SALE.profit + ORDER.profit);

    await setFlag(false);
    const off = await closure.execute(companyId, DAY);
    expect(off.ordersTotal).toBe(0);
    expect(off.salesProfit).toBe(SALE.profit);
  });

  // ─── 5. /reports/extended-summary ───────────────────────────────────────

  maybe('resumen extendido: ON suma el pedido a total y ganancia; OFF no', async () => {
    await setFlag(true);
    const on = await extended.execute(companyId, DAY, DAY);
    expect(on.ventas.pedidos).toBe(ORDER.total);
    expect(on.ventas.total).toBe(SALE.total + ORDER.total);
    expect(on.ventas.ganancia).toBe(SALE.profit + ORDER.profit);

    await setFlag(false);
    const off = await extended.execute(companyId, DAY, DAY);
    expect(off.ventas.pedidos).toBe(0);
    expect(off.ventas.total).toBe(SALE.total);
    expect(off.ventas.ganancia).toBe(SALE.profit);
  });

  // ─── Invariante transversal ─────────────────────────────────────────────

  maybe('OFF deja los 5 endpoints EXACTAMENTE como si el pedido no existiera', async () => {
    await setFlag(false);
    const [t, b, p, c, e] = await Promise.all([
      today.execute(companyId, DAY),
      breakEven.execute(companyId, DAY),
      performance.execute(companyId, DAY, DAY),
      closure.execute(companyId, DAY),
      extended.execute(companyId, DAY, DAY),
    ]);

    // Ninguna cifra puede contener rastro del pedido (ni 2.500 ni 740).
    expect(t.totalCollected).toBe(SALE.total);
    expect(t.profit).toBe(SALE.profit);
    expect(b.dayRealProfit).toBe(SALE.profit);
    expect(p.totals.sales).toBe(SALE.total);
    expect(p.totals.profit).toBe(SALE.profit);
    expect(c.salesProfit).toBe(SALE.profit);
    expect(e.ventas.total).toBe(SALE.total);
    expect(e.ventas.ganancia).toBe(SALE.profit);
  });

  maybe('el flag AUSENTE (company sin la fila) se comporta como OFF', async () => {
    // Default seguro: una company que nunca tocó el toggle NO debe ver pedidos.
    await ds!.query(`DELETE FROM app_settings WHERE company_id = $1 AND key = $2`, [
      String(companyId),
      'include_orders_in_reports',
    ]);

    const t = await today.execute(companyId, DAY);
    expect(t.ordersTotal).toBe(0);
    expect(t.totalCollected).toBe(SALE.total);
    expect(t.profit).toBe(SALE.profit);
  });
});
