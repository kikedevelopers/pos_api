import type { DataSource } from 'typeorm';

import { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import { GetTodayAction } from '@/modules/dashboard/actions/get-today.action';
import { GetDailyClosureAction } from '@/modules/reports/actions/get-daily-closure.action';
import { GetExtendedSummaryAction } from '@/modules/reports/actions/get-extended-summary.action';

import {
  cleanupCompany,
  createDisposableCompany,
  includeOrdersFlagStub,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL) — regresión de la GANANCIA de ventas del día cuando una factura
 * de contado tiene VARIOS pagos o método MIXTO (CASH + TRANSFER).
 *
 * Bug corregido: `fetchCashSales`/`fetchTransferSales` (cierre y resumen
 * extendido) hacían `SUM(si.cost)` sobre el JOIN con `sale_payments`, que
 * produce UNA fila por pago. Una factura con dos pagos —o método mixto— aparecía
 * varias veces y su costo se contaba una vez POR PAGO, DUPLICÁNDOLO y
 * SUBESTIMANDO la utilidad. Esto hacía que la "Rentabilidad" de Ventas del Día
 * (cierre) no cuadrara con la "Ganancia real" del dashboard (que suma
 * `si.profit` una vez por factura).
 *
 * Fix: el costo se PRORRATEA por lo cobrado
 * (`si.cost * LEAST(sp.amount, si.total) / si.total`), de modo que la suma entre
 * las ramas de una factura da su costo EXACTAMENTE una vez.
 *
 * Cada escenario vive en su propia company desechable para aserciones limpias.
 * Fecha fija (Colombia) 2026-03-15; el instante 15:00Z cae dentro del día tanto
 * en rango UTC (cierre) como en rango Colombia (resumen extendido).
 */

let seq = 0;

async function insertSale(
  db: DataSource,
  companyId: number,
  opts: { total: number; cost: number; profit: number; soldAtIso: string },
): Promise<string> {
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
      `E2E-MIX-T-${suffix}`,
      `E2E-MIX-V-${suffix}`,
      opts.total,
      opts.cost,
      opts.profit,
      opts.soldAtIso,
    ],
  );
  return r[0].id as string;
}

async function insertPayment(
  db: DataSource,
  companyId: number,
  saleInvoiceId: string,
  opts: { method: 'CASH' | 'TRANSFER'; amount: number; createdAtIso: string; bankName?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO sale_payments
       (company_id, sale_invoice_id, payment_method, amount, change_amount,
        account_type, account_id, bank_name, is_voided, created_at)
     VALUES ($1, $2, $3::payment_method, $4, 0, $5, 1, $6, false, $7)`,
    [
      String(companyId),
      saleInvoiceId,
      opts.method,
      opts.amount,
      opts.method === 'TRANSFER' ? 'bank' : 'cash_register',
      opts.bankName ?? null,
      opts.createdAtIso,
    ],
  );
}

describe('Ganancia con pagos múltiples / método mixto (cierre + dashboard + extendido, e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let dashboard: GetTodayAction;
  let closure: GetDailyClosureAction;
  let extended: GetExtendedSummaryAction;

  const TODAY = '2026-03-15';
  const AT = '2026-03-15T15:00:00.000Z'; // 10:00 Colombia — dentro del día en UTC y en Colombia.

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — mixed-payment-profit e2e SKIPPED.');
      return;
    }
    dashboard = new GetTodayAction(ds, includeOrdersFlagStub(false));
    // Flag `include_orders_in_reports` sin fila en app_settings → OFF.
    closure = new GetDailyClosureAction(ds, new GetIncludeOrdersInReportsAction(ds));
    extended = new GetExtendedSummaryAction(ds, new GetIncludeOrdersInReportsAction(ds));
  });

  afterAll(async () => {
    if (ds) {
      await ds.destroy();
    }
  });

  it('MÉTODO MIXTO (CASH+TRANSFER): el costo NO se duplica → salesProfit = utilidad real', async () => {
    if (!ds) {
      return;
    }
    const cid = await createDisposableCompany(ds, '__E2E_MIX_METHOD__');
    try {
      // Venta total 500, costo 300, utilidad 200. Pagada 300 efectivo + 200 transfer.
      const inv = await insertSale(ds, cid, { total: 500, cost: 300, profit: 200, soldAtIso: AT });
      await insertPayment(ds, cid, inv, { method: 'CASH', amount: 300, createdAtIso: AT });
      await insertPayment(ds, cid, inv, {
        method: 'TRANSFER',
        amount: 200,
        createdAtIso: AT,
        bankName: 'Bancolombia',
      });

      const cierre = await closure.execute(cid, TODAY);
      // Ingresos por método (sin cambios): 300 efectivo, 200 consignación.
      expect(cierre.cashSalesTotal).toBe(300);
      expect(cierre.consignacionesVentas).toBe(200);
      // Utilidad de ventas del día = 200 (NO -100 como con el costo duplicado:
      // cash 300-300 + transfer 200-300 = -100). Con prorrateo: 120 + 80 = 200.
      expect(cierre.salesProfit).toBe(200);
      // Margen = 200 / 500 = 40%.
      expect(cierre.salesMargin).toBe(40);

      // El dashboard ya sumaba si.profit una vez por factura → 200. Deben CUADRAR.
      const dash = await dashboard.execute(cid, TODAY);
      expect(dash.profit).toBe(200);
      expect(cierre.salesProfit).toBe(dash.profit);

      // El resumen extendido comparte el helper → misma utilidad y margen.
      const ext = await extended.execute(cid, TODAY, TODAY);
      expect(ext.ventas.total).toBe(500);
      expect(ext.ventas.ganancia).toBe(200);
      expect(ext.ventas.margen).toBe(40);
    } finally {
      await ds.query(`DELETE FROM sale_payments WHERE company_id = $1`, [String(cid)]);
      await ds.query(`DELETE FROM sale_invoices WHERE company_id = $1`, [String(cid)]);
      await cleanupCompany(ds, cid);
    }
  });

  it('MULTI-PAGO mismo método (dos pagos CASH): el costo se cuenta una vez', async () => {
    if (!ds) {
      return;
    }
    const cid = await createDisposableCompany(ds, '__E2E_MULTI_CASH__');
    try {
      // Venta total 100, costo 60, utilidad 40. Pagada en dos partes CASH: 40 + 60.
      const inv = await insertSale(ds, cid, { total: 100, cost: 60, profit: 40, soldAtIso: AT });
      await insertPayment(ds, cid, inv, { method: 'CASH', amount: 40, createdAtIso: AT });
      await insertPayment(ds, cid, inv, { method: 'CASH', amount: 60, createdAtIso: AT });

      const cierre = await closure.execute(cid, TODAY);
      expect(cierre.cashSalesTotal).toBe(100);
      // Con costo duplicado daría 100 - 120 = -20. Con prorrateo: 40.
      expect(cierre.salesProfit).toBe(40);
      expect(cierre.salesMargin).toBe(40);

      const dash = await dashboard.execute(cid, TODAY);
      expect(dash.profit).toBe(40);
      expect(cierre.salesProfit).toBe(dash.profit);
    } finally {
      await ds.query(`DELETE FROM sale_payments WHERE company_id = $1`, [String(cid)]);
      await ds.query(`DELETE FROM sale_invoices WHERE company_id = $1`, [String(cid)]);
      await cleanupCompany(ds, cid);
    }
  });

  it('CONTADO simple (un solo pago): regresión — la utilidad sigue siendo la completa', async () => {
    if (!ds) {
      return;
    }
    const cid = await createDisposableCompany(ds, '__E2E_SINGLE_PAY__');
    try {
      const inv = await insertSale(ds, cid, { total: 100, cost: 60, profit: 40, soldAtIso: AT });
      await insertPayment(ds, cid, inv, { method: 'CASH', amount: 100, createdAtIso: AT });

      const cierre = await closure.execute(cid, TODAY);
      expect(cierre.cashSalesTotal).toBe(100);
      expect(cierre.salesProfit).toBe(40);

      const dash = await dashboard.execute(cid, TODAY);
      expect(dash.profit).toBe(40);
      expect(cierre.salesProfit).toBe(dash.profit);
    } finally {
      await ds.query(`DELETE FROM sale_payments WHERE company_id = $1`, [String(cid)]);
      await ds.query(`DELETE FROM sale_invoices WHERE company_id = $1`, [String(cid)]);
      await cleanupCompany(ds, cid);
    }
  });
});
