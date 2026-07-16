import type { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import { GetPerformanceAction } from '@/modules/dashboard/actions/get-performance.action';
import { GetTodayAction } from '@/modules/dashboard/actions/get-today.action';
import { GetTodayByCashierAction } from '@/modules/dashboard/actions/get-today-by-cashier.action';
import {
  fetchDayMetricsMap,
  sumRangeTotals,
} from '@/modules/pos-reports/internal/comparative-metrics';
import { GetSalesReportAction } from '@/modules/pos-reports/actions/get-sales-report.action';
import { GetCustomersRfmAction } from '@/modules/reports/actions/get-customers-rfm.action';
import { GetDailyClosureAction } from '@/modules/reports/actions/get-daily-closure.action';
import { GetExtendedSummaryAction } from '@/modules/reports/actions/get-extended-summary.action';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';

import {
  cleanupCompany,
  createDisposableCompany,
  includeOrdersFlagStub,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL pos_db) — BATERÍA "créditos como venta (devengado)".
 *
 * Verifica AL CENTAVO que TODOS los informes tratan la venta a crédito como una
 * venta del día (base devengado) y que la CAJA/recaudo/abonos siguen siendo
 * dinero real, sin doble conteo. Cada escenario vive en su company DESECHABLE.
 *
 * Fecha fija Colombia 2026-03-15; instante 15:00Z cae dentro del día en UTC
 * (cierre / reporte de ventas) y en Colombia (extendido / dashboard).
 */

const TODAY = '2026-03-15';
const AT = '2026-03-15T15:00:00.000Z';
const CASHIER_ID = 7;

const OWNER: AuthUser = {
  user_id: CASHIER_ID,
  company_id: 0,
  name: 'E2E',
  lastname: 'Owner',
  type: 'owner',
  account: 'user',
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

let seq = 0;
function uniq(): string {
  seq += 1;
  return `${Date.now()}-${seq}`;
}

async function insertSale(
  db: DataSource,
  cid: number,
  o: { total: number; cost: number; customerId?: string | null },
): Promise<string> {
  const s = uniq();
  const profit = round2(o.total - o.cost);
  const margin = o.total > 0 ? Math.round((profit / o.total) * 1e4) / 1e4 : 0;
  const r = await db.query(
    `INSERT INTO sale_invoices
       (company_id, ticket_type, ticket_number, sale_number, total, cost, profit, margin,
        is_deleted, sold_at, created_at, updated_at, created_by_id, customer_id)
     VALUES ($1,'SALE',$2,$3,$4,$5,$6,$7,false,$8,$8,$8,$9,$10) RETURNING id`,
    [
      String(cid),
      `E2E-T-${s}`,
      `E2E-V-${s}`,
      o.total,
      o.cost,
      profit,
      margin,
      AT,
      String(CASHIER_ID),
      o.customerId ?? null,
    ],
  );
  return r[0].id as string;
}

async function insertPayment(
  db: DataSource,
  cid: number,
  invId: string,
  o: { method: 'CASH' | 'TRANSFER'; amount: number; at?: string },
): Promise<string> {
  const r = await db.query(
    `INSERT INTO sale_payments
       (company_id, sale_invoice_id, payment_method, amount, change_amount,
        account_type, account_id, bank_name, is_voided, created_at, created_by_id)
     VALUES ($1,$2,$3::payment_method,$4,0,$5,1,$6,false,$7,$8) RETURNING id`,
    [
      String(cid),
      invId,
      o.method,
      o.amount,
      o.method === 'TRANSFER' ? 'bank' : 'cash_register',
      o.method === 'TRANSFER' ? 'Bancolombia' : null,
      o.at ?? AT,
      String(CASHIER_ID),
    ],
  );
  return r[0].id as string;
}

async function insertCustomer(db: DataSource, cid: number, name: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO customers (company_id, name) VALUES ($1,$2) RETURNING id`,
    [String(cid), name],
  );
  return r[0].id as string;
}

async function insertCredit(
  db: DataSource,
  cid: number,
  invId: string,
  customerId: string,
  o: { total: number; paid?: number },
): Promise<string> {
  const paid = o.paid ?? 0;
  const balance = round2(o.total - paid);
  const status = balance <= 0 ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'PENDING';
  const r = await db.query(
    `INSERT INTO sale_credits
       (company_id, sale_invoice_id, customer_id, total_amount, paid_amount, balance, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [String(cid), invId, customerId, o.total, paid, balance, status],
  );
  return r[0].id as string;
}

/** Recomputa paid_amount/balance/status de un crédito a partir de sus abonos vivos. */
async function resyncCredit(db: DataSource, cid: number, invId: string): Promise<void> {
  await db.query(
    `UPDATE sale_credits sc
       SET paid_amount = COALESCE(p.paid,0),
           balance = sc.total_amount - COALESCE(p.paid,0),
           status = (CASE WHEN sc.total_amount - COALESCE(p.paid,0) <= 0 THEN 'PAID'
                         WHEN COALESCE(p.paid,0) > 0 THEN 'PARTIALLY_PAID'
                         ELSE 'PENDING' END)::credit_status
     FROM (SELECT $2::bigint AS inv, COALESCE(SUM(amount),0) AS paid
             FROM sale_payments WHERE sale_invoice_id = $2 AND company_id = $1 AND is_voided=false) p
     WHERE sc.sale_invoice_id = $2 AND sc.company_id = $1`,
    [String(cid), invId],
  );
}

async function insertCreditNote(
  db: DataSource,
  cid: number,
  invId: string,
  o: { noteType: 'CREDIT' | 'DEBIT'; total: number; unitCost: number; quantity: number },
): Promise<void> {
  const s = uniq();
  // Producto mínimo para la FK product_id de la línea de la nota.
  const prod = (
    await db.query(
      `INSERT INTO products (company_id, name, cost, stock, product_type, show_in_pos, is_purchasable, is_archived)
       VALUES ($1,$2,$3,0,'SIMPLE',true,false,false) RETURNING id`,
      [String(cid), `E2E-NC-PROD-${s}`, o.unitCost],
    )
  )[0].id;
  const nid = (
    await db.query(
      `INSERT INTO credit_notes
         (company_id, sale_invoice_id, note_type, operation_type, note_number, total, is_deleted, created_at, created_by_id)
       VALUES ($1,$2,$3::note_type,'PARTIAL_VOID'::operation_type,$4,$5,false,$6,$7) RETURNING id`,
      [String(cid), invId, o.noteType, `E2E-NC-${s}`, o.total, AT, String(CASHIER_ID)],
    )
  )[0].id;
  await db.query(
    `INSERT INTO credit_note_lines (company_id, credit_note_id, product_id, description, unit_cost, quantity)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [String(cid), nid, prod, `E2E-NC-line-${s}`, o.unitCost, o.quantity],
  );
}

async function wipeSales(db: DataSource, cid: number): Promise<void> {
  const c = String(cid);
  await db.query(
    `DELETE FROM credit_note_lines WHERE company_id=$1`,
    [c],
  );
  await db.query(`DELETE FROM credit_notes WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM sale_payments WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM sale_credits WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM sale_invoice_lines WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM sale_invoices WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM customers WHERE company_id=$1`, [c]);
}

// ─── Suite ──────────────────────────────────────────────────────────────────

let ds: DataSource | null = null;

describe('Créditos como venta — cuadra al centavo (e2e pos_db)', () => {
  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — credits-as-sales-cuadra SKIPPED.');
    }
  });
  afterAll(async () => {
    if (ds) {
      await ds.destroy();
    }
  });

  const flagOff = (): GetIncludeOrdersInReportsAction => includeOrdersFlagStub(false);
  const permsAll = {
    execute: () => Promise.resolve(['canViewAllSales', 'canAccessSalesReport']),
  } as unknown as ResolveEffectivePermissionsAction;

  const build = (d: DataSource) => ({
    sales: new GetSalesReportAction(d, permsAll, flagOff()),
    closure: new GetDailyClosureAction(d, flagOff()),
    extended: new GetExtendedSummaryAction(d, flagOff()),
    today: new GetTodayAction(d, flagOff()),
    cashier: new GetTodayByCashierAction(d),
    perf: new GetPerformanceAction(d, flagOff()),
    rfm: new GetCustomersRfmAction(d),
  });

  const withCompany = async (
    name: string,
    fn: (cid: number, a: ReturnType<typeof build>) => Promise<void>,
  ): Promise<void> => {
    if (!ds) {
      return;
    }
    const d = ds;
    const cid = await createDisposableCompany(d, name);
    try {
      await fn(cid, build(d));
    } finally {
      await wipeSales(d, cid);
      await cleanupCompany(d, cid);
    }
  };

  const actor = (cid: number): AuthUser => ({ ...OWNER, company_id: cid });

  // ── 1. Contado efectivo ──
  it('CONTADO efectivo: reportes cuentan la venta; devengado = caja', async () => {
    await withCompany('__E2E_CS_CASH__', async (cid, a) => {
      const inv = await insertSale(ds!, cid, { total: 4300, cost: 2892.63 });
      await insertPayment(ds!, cid, inv, { method: 'CASH', amount: 4300 });
      const gan = round2(4300 - 2892.63); // 1407.37

      const sr = await a.sales.execute(cid, { dateFrom: TODAY, dateTo: TODAY }, actor(cid));
      expect(sr.summary.total_revenue).toBe(4300);
      expect(sr.summary.total_profit).toBe(1407.37);
      expect(sr.summary.total_sales_count).toBe(1);
      expect((sr.tickets[0] as { paymentType: string }).paymentType).toBe('CASH');

      const cl = await a.closure.execute(cid, TODAY);
      expect(cl.cashSalesTotal).toBe(4300);
      expect(cl.salesProfit).toBe(1407.37);
      expect(cl.creditsBreakdown.newCreditsTotal).toBe(0);

      const t = await a.today.execute(cid, TODAY);
      expect(t.totalSales).toBe(4300);
      expect(t.creditSales).toBe(0);
      expect(t.salesProfit).toBe(gan);
      expect(t.profit).toBe(gan); // caja == devengado (contado pagado, sin crédito)
      expect(round2(t.salesSurplus)).toBe(round2(4300 - gan));

      const c = await a.cashier.execute(cid, TODAY);
      const ca = c.cashiers[0];
      expect(ca.totalSales).toBe(4300);
      expect(ca.cashProfit).toBe(1407.37);
      expect(ca.creditProfit).toBe(0);
      expect(round2(ca.cashProfit + ca.transferProfit + ca.creditProfit)).toBe(ca.profit);
    });
  });

  // ── 2. Contado consignación ──
  it('CONTADO consignación: cae en transferSales y su ganancia en el método', async () => {
    await withCompany('__E2E_CS_TRANSFER__', async (cid, a) => {
      const inv = await insertSale(ds!, cid, { total: 16000, cost: 11720.48 });
      await insertPayment(ds!, cid, inv, { method: 'TRANSFER', amount: 16000 });

      const cl = await a.closure.execute(cid, TODAY);
      expect(cl.consignacionesVentas).toBe(16000);
      expect(cl.cashSalesTotal).toBe(0);

      const c = await a.cashier.execute(cid, TODAY);
      const ca = c.cashiers[0];
      expect(ca.transferSales).toBe(16000);
      expect(ca.transferProfit).toBe(round2(16000 - 11720.48));
      expect(ca.cashProfit).toBe(0);
      expect(round2(ca.cashProfit + ca.transferProfit + ca.creditProfit)).toBe(ca.profit);
    });
  });

  // ── 3. Contado MIXTO ──
  it('CONTADO mixto (efectivo+consignación): ganancia por método prorratea y suma', async () => {
    await withCompany('__E2E_CS_MIXED__', async (cid, a) => {
      const inv = await insertSale(ds!, cid, { total: 10000, cost: 6000 }); // gan 4000
      await insertPayment(ds!, cid, inv, { method: 'CASH', amount: 4000 });
      await insertPayment(ds!, cid, inv, { method: 'TRANSFER', amount: 6000 });

      const c = await a.cashier.execute(cid, TODAY);
      const ca = c.cashiers[0];
      // Prorrateo: cash 4000/10000*4000=1600 ; transfer 6000/10000*4000=2400.
      expect(ca.cashProfit).toBe(1600);
      expect(ca.transferProfit).toBe(2400);
      expect(round2(ca.cashProfit + ca.transferProfit)).toBe(ca.profit);
      expect(ca.profit).toBe(4000);
      expect(ca.totalSales).toBe(10000);
      // El desglose Tipo de pago del reporte de ventas = MIXED.
      const sr = await a.sales.execute(cid, { dateFrom: TODAY, dateTo: TODAY }, actor(cid));
      expect((sr.tickets[0] as { paymentType: string }).paymentType).toBe('MIXED');
    });
  });

  // ── 4. Crédito puro (sin pagos) ──
  it('CRÉDITO puro: cuenta como venta devengada; caja/recaudo intactos', async () => {
    await withCompany('__E2E_CREDIT_PURE__', async (cid, a) => {
      const cust = await insertCustomer(ds!, cid, 'Cliente Credito');
      const inv = await insertSale(ds!, cid, { total: 12500, cost: 8800, customerId: cust });
      await insertCredit(ds!, cid, inv, cust, { total: 12500 });
      const gan = round2(12500 - 8800); // 3700

      // Reporte de ventas: incluye el crédito, paymentType='CREDIT'.
      const sr = await a.sales.execute(cid, { dateFrom: TODAY, dateTo: TODAY }, actor(cid));
      expect(sr.summary.total_revenue).toBe(12500);
      expect(sr.summary.total_profit).toBe(gan);
      expect(sr.summary.total_sales_count).toBe(1);
      expect((sr.tickets[0] as { paymentType: string }).paymentType).toBe('CREDIT');
      expect((sr.tickets[0] as { isPending: boolean }).isPending).toBe(true);

      // Comparativa (devengado): la venta suma completa.
      const map = await fetchDayMetricsMap(ds!, cid, new Date('2026-03-15T05:00:00Z'), new Date('2026-03-16T04:59:59.999Z'));
      const cmp = sumRangeTotals(map, [TODAY]);
      expect(cmp.sales).toBe(12500);
      expect(cmp.profit).toBe(gan);

      // Finanzas cierre: crédito discriminado, suma a salesProfit; caja = 0.
      const cl = await a.closure.execute(cid, TODAY);
      expect(cl.creditsBreakdown.newCreditsTotal).toBe(12500);
      expect(cl.creditsBreakdown.newCreditsProfit).toBe(gan);
      expect(cl.creditsBreakdown.newCreditsMargin).toBe(round2((gan / 12500) * 100)); // 29.6
      expect(cl.salesProfit).toBe(gan);
      expect(cl.finalTotal).toBe(0); // NADA de caja (crédito no cobrado)
      expect(cl.creditsBreakdown.abonosTotal).toBe(0);

      // Extendido: ventas.total incl crédito, ganancia devengada, discriminada.
      const ext = await a.extended.execute(cid, TODAY, TODAY);
      expect(ext.ventas.credito).toBe(12500);
      expect(ext.ventas.creditoGanancia).toBe(gan);
      expect(ext.ventas.total).toBe(12500);
      expect(ext.ventas.ganancia).toBe(gan);

      // Dashboard today: devengado incluye crédito; CAJA no.
      const t = await a.today.execute(cid, TODAY);
      expect(t.totalSales).toBe(12500);
      expect(t.creditSales).toBe(12500);
      expect(t.salesProfit).toBe(gan);
      expect(t.newCredits.profit).toBe(gan);
      expect(t.totalCollected).toBe(0); // caja real
      expect(t.profit).toBe(0); // ganancia cobrada
      expect(t.salesRealProfit).toBe(gan);

      // Cajero: crédito en su método con ganancia/margen.
      const c = await a.cashier.execute(cid, TODAY);
      const ca = c.cashiers[0];
      expect(ca.creditSales).toBe(12500);
      expect(ca.creditProfit).toBe(gan);
      expect(ca.creditMargin).toBe(round2((gan / 12500) * 100));
      expect(ca.totalSales).toBe(12500);
      expect(round2(ca.cashProfit + ca.transferProfit + ca.creditProfit)).toBe(ca.profit);

      // RFM: el cliente acumula la venta a crédito.
      const rfm = await a.rfm.execute(cid, TODAY, TODAY);
      expect(rfm.customers.length).toBe(1);
      expect(rfm.customers[0].totalAmount).toBe(12500);
      expect(rfm.customers[0].totalProfit).toBe(gan);

      // CONSISTENCIA CRUZADA: salesProfit del cierre == del dashboard; total ventas coincide.
      expect(cl.salesProfit).toBe(t.salesProfit);
      expect(t.totalSales).toBe(sr.summary.total_revenue);
    });
  });

  // ── 5-8 y 14: INVARIANCIA ANTE ABONOS + combinaciones ──
  it('INVARIANCIA: abonos (parcial/total, efectivo/consignación) NO cambian el devengado; solo la caja', async () => {
    await withCompany('__E2E_CREDIT_ABONOS__', async (cid, a) => {
      const cust = await insertCustomer(ds!, cid, 'Cliente Abonos');
      // Contado 5000/3000 (gan 2000) + crédito 12500/8800 (gan 3700).
      const contado = await insertSale(ds!, cid, { total: 5000, cost: 3000 });
      await insertPayment(ds!, cid, contado, { method: 'CASH', amount: 5000 });
      const inv = await insertSale(ds!, cid, { total: 12500, cost: 8800, customerId: cust });
      await insertCredit(ds!, cid, inv, cust, { total: 12500 });

      const ganTotal = round2(2000 + 3700); // 5700
      const ventasTotal = 17500;

      // Snapshot DEVENGADO antes de abonos.
      const before = {
        sr: (await a.sales.execute(cid, { dateFrom: TODAY, dateTo: TODAY }, actor(cid))).summary,
        cl: await a.closure.execute(cid, TODAY),
        t: await a.today.execute(cid, TODAY),
      };
      expect(before.sr.total_revenue).toBe(ventasTotal);
      expect(before.sr.total_profit).toBe(ganTotal);
      expect(before.cl.salesProfit).toBe(ganTotal);
      expect(before.t.totalSales).toBe(ventasTotal);
      expect(before.t.salesProfit).toBe(ganTotal);
      // Caja antes: solo el contado.
      expect(before.t.totalCollected).toBe(5000);
      expect(before.t.profit).toBe(2000); // ganancia cobrada = contado

      // Abono PARCIAL efectivo 4000 + parcial consignación 2500 (total 6500).
      await insertPayment(ds!, cid, inv, { method: 'CASH', amount: 4000 });
      const abonoConsig = await insertPayment(ds!, cid, inv, { method: 'TRANSFER', amount: 2500 });
      await resyncCredit(ds!, cid, inv);

      const after = {
        sr: (await a.sales.execute(cid, { dateFrom: TODAY, dateTo: TODAY }, actor(cid))).summary,
        cl: await a.closure.execute(cid, TODAY),
        t: await a.today.execute(cid, TODAY),
        cmpMap: await fetchDayMetricsMap(ds!, cid, new Date('2026-03-15T05:00:00Z'), new Date('2026-03-16T04:59:59.999Z')),
      };
      const cmp = sumRangeTotals(after.cmpMap, [TODAY]);

      // DEVENGADO INVARIANTE: reporte de ventas, cierre salesProfit, today devengado, comparativa NO cambian.
      expect(after.sr.total_revenue).toBe(ventasTotal);
      expect(after.sr.total_profit).toBe(ganTotal);
      expect(after.cl.salesProfit).toBe(before.cl.salesProfit);
      expect(after.t.totalSales).toBe(ventasTotal);
      expect(after.t.salesProfit).toBe(ganTotal);
      expect(cmp.sales).toBe(ventasTotal);
      expect(cmp.profit).toBe(ganTotal);

      // CAJA sí cambia: abonos entran a Recaudo de Cartera (6500) y a la caja.
      expect(after.cl.creditsBreakdown.abonosCash).toBe(4000);
      expect(after.cl.creditsBreakdown.abonosConsignacion).toBe(2500);
      expect(after.cl.creditsBreakdown.abonosTotal).toBe(6500);
      expect(after.t.creditPaymentsTotal).toBe(6500);
      expect(after.t.totalCollected).toBe(round2(5000 + 6500)); // contado + abonos
      // El crédito devengado NO entra a la caja: creditSales sigue discriminado.
      expect(after.t.creditSales).toBe(12500);

      // Cajero: abonos discriminados aparte, NO en totalSales.
      const ca = (await a.cashier.execute(cid, TODAY)).cashiers[0];
      expect(ca.creditPaymentsTotal).toBe(6500);
      expect(ca.totalSales).toBe(ventasTotal);
      expect(round2(ca.cashProfit + ca.transferProfit + ca.creditProfit)).toBe(ca.profit);

      // ── Eliminar UN abono (el de consignación) → devengado sigue igual, caja baja ──
      await ds!.query(`DELETE FROM sale_payments WHERE id = $1`, [abonoConsig]);
      await resyncCredit(ds!, cid, inv);
      const t2 = await a.today.execute(cid, TODAY);
      const cl2 = await a.closure.execute(cid, TODAY);
      expect(t2.totalSales).toBe(ventasTotal); // devengado intacto
      expect(t2.salesProfit).toBe(ganTotal);
      expect(cl2.salesProfit).toBe(ganTotal);
      expect(cl2.creditsBreakdown.abonosTotal).toBe(4000); // solo queda el de efectivo
      expect(t2.totalCollected).toBe(round2(5000 + 4000));

      // ── Eliminar TODOS los abonos → caja vuelve a solo contado; devengado igual ──
      await ds!.query(`DELETE FROM sale_payments WHERE sale_invoice_id = $1 AND created_by_id = $2 AND amount IN (4000)`, [inv, String(CASHIER_ID)]);
      await resyncCredit(ds!, cid, inv);
      const t3 = await a.today.execute(cid, TODAY);
      const cl3 = await a.closure.execute(cid, TODAY);
      expect(cl3.creditsBreakdown.abonosTotal).toBe(0);
      expect(t3.totalCollected).toBe(5000); // solo contado
      expect(t3.totalSales).toBe(ventasTotal); // devengado intacto
      expect(t3.salesProfit).toBe(ganTotal);
      // El crédito vuelve a PENDING con balance completo.
      const bal = await ds!.query(`SELECT balance, status FROM sale_credits WHERE sale_invoice_id=$1`, [inv]);
      expect(round2(Number(bal[0].balance))).toBe(12500);
      expect(bal[0].status).toBe('PENDING');
    });
  });

  // ── Crédito pagado COMPLETO por abonos ──
  it('CRÉDITO pagado completo: devengado igual; caja recauda el total; balance 0 PAID', async () => {
    await withCompany('__E2E_CREDIT_PAID__', async (cid, a) => {
      const cust = await insertCustomer(ds!, cid, 'Cliente Pagado');
      const inv = await insertSale(ds!, cid, { total: 8000, cost: 5200, customerId: cust });
      await insertCredit(ds!, cid, inv, cust, { total: 8000 });
      const gan = round2(8000 - 5200); // 2800
      // Pago total en dos abonos (efectivo 5000 + consignación 3000).
      await insertPayment(ds!, cid, inv, { method: 'CASH', amount: 5000 });
      await insertPayment(ds!, cid, inv, { method: 'TRANSFER', amount: 3000 });
      await resyncCredit(ds!, cid, inv);

      const cl = await a.closure.execute(cid, TODAY);
      expect(cl.creditsBreakdown.newCreditsTotal).toBe(8000); // sigue siendo venta a crédito
      expect(cl.creditsBreakdown.newCreditsProfit).toBe(gan);
      expect(cl.salesProfit).toBe(gan); // devengado
      expect(cl.creditsBreakdown.abonosTotal).toBe(8000); // recaudado completo

      const t = await a.today.execute(cid, TODAY);
      expect(t.totalSales).toBe(8000); // devengado
      expect(t.salesProfit).toBe(gan);
      expect(t.totalCollected).toBe(8000); // caja: todo el abono
      // Ganancia COBRADA (caja) al 100% cobrado = ganancia completa.
      expect(t.profit).toBe(gan);

      const bal = await ds!.query(`SELECT balance,status FROM sale_credits WHERE sale_invoice_id=$1`, [inv]);
      expect(round2(Number(bal[0].balance))).toBe(0);
      expect(bal[0].status).toBe('PAID');
    });
  });

  // ── Editar un crédito (cambiar total/balance) con y sin abono ──
  it('EDITAR crédito: el reporte de ventas usa el si.total; el saldo usa sc.balance', async () => {
    await withCompany('__E2E_CREDIT_EDIT__', async (cid, a) => {
      const cust = await insertCustomer(ds!, cid, 'Cliente Editado');
      const inv = await insertSale(ds!, cid, { total: 10000, cost: 6500, customerId: cust });
      await insertCredit(ds!, cid, inv, cust, { total: 10000 });

      // Editar la venta a 12000/7800 (y su crédito a 12000). Simula edición del ticket.
      const nuevoProfit = round2(12000 - 7800);
      const nuevoMargin = Math.round((nuevoProfit / 12000) * 1e4) / 1e4;
      await ds!.query(
        `UPDATE sale_invoices SET total=12000, cost=7800, profit=$2, margin=$3 WHERE id=$1`,
        [inv, nuevoProfit, nuevoMargin],
      );
      await ds!.query(
        `UPDATE sale_credits SET total_amount=12000, balance=12000 WHERE sale_invoice_id=$1`,
        [inv],
      );

      const sr = await a.sales.execute(cid, { dateFrom: TODAY, dateTo: TODAY }, actor(cid));
      expect(sr.summary.total_revenue).toBe(12000);
      expect(sr.summary.total_profit).toBe(nuevoProfit); // 4200
      const ticket = sr.tickets[0] as { balanceDue: number; isPending: boolean };
      expect(ticket.balanceDue).toBe(12000);
      expect(ticket.isPending).toBe(true);

      const cl = await a.closure.execute(cid, TODAY);
      expect(cl.creditsBreakdown.newCreditsTotal).toBe(12000);
      expect(cl.creditsBreakdown.newCreditsProfit).toBe(nuevoProfit);
    });
  });

  // ── Crédito con NOTA CRÉDITO parcial ──
  it('CRÉDITO con nota crédito parcial: reporte de ventas netea la NC', async () => {
    await withCompany('__E2E_CREDIT_NOTE__', async (cid, a) => {
      const cust = await insertCustomer(ds!, cid, 'Cliente NC');
      const inv = await insertSale(ds!, cid, { total: 20000, cost: 13000, customerId: cust });
      await insertCredit(ds!, cid, inv, cust, { total: 20000 });
      // NC parcial de 5000 (costo 3250) → neto venta 15000, costo 9750, gan 5250.
      await insertCreditNote(ds!, cid, inv, { noteType: 'CREDIT', total: 5000, unitCost: 3250, quantity: 1 });

      const sr = await a.sales.execute(cid, { dateFrom: TODAY, dateTo: TODAY }, actor(cid));
      // total_revenue = 20000 - 5000 (NC) = 15000.
      expect(sr.summary.total_revenue).toBe(15000);
      expect(sr.summary.total_cost).toBe(round2(13000 - 3250)); // 9750
      expect(sr.summary.total_profit).toBe(round2(15000 - 9750)); // 5250
    });
  });

  // ── Performance (gráfico Rendimiento) incluye crédito devengado ──
  it('PERFORMANCE: la serie de ventas incluye el crédito por su valor íntegro', async () => {
    await withCompany('__E2E_PERF__', async (cid, a) => {
      const cust = await insertCustomer(ds!, cid, 'Cliente Perf');
      const contado = await insertSale(ds!, cid, { total: 3000, cost: 1800 });
      await insertPayment(ds!, cid, contado, { method: 'CASH', amount: 3000 });
      const inv = await insertSale(ds!, cid, { total: 7000, cost: 4900, customerId: cust });
      await insertCredit(ds!, cid, inv, cust, { total: 7000 });

      const p = await a.perf.execute(cid, TODAY, TODAY);
      // Ventas del día (devengado) = 3000 + 7000 = 10000.
      expect(p.totals.sales).toBe(10000);
      // Ganancia = 1200 (contado) + 2100 (crédito) = 3300.
      expect(p.totals.profit).toBe(round2(1200 + 2100));
      // Créditos generados (serie discriminada) = 7000.
      expect(p.totals.credits).toBe(7000);
    });
  });
});
