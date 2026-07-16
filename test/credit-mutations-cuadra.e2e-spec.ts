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
 * E2E (BD REAL pos_db) — MUTACIONES de crédito cuadran al centavo.
 *
 * El valor DEVENGADO de una venta = su total CONSOLIDADO (si.total − NC + ND).
 * El Reporte de Ventas es la FUENTE DE VERDAD (netea notas). Todos los demás
 * informes deben cuadrar con él tras editar/anular/abonar.
 */

const TODAY = '2026-03-15';
const AT = '2026-03-15T15:00:00.000Z';
const CASHIER_ID = 7;
const RANGE_A = new Date('2026-03-15T05:00:00Z');
const RANGE_B = new Date('2026-03-16T04:59:59.999Z');

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
const uniq = (): string => `${Date.now()}-${(seq += 1)}`;

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
    [String(cid), `E2E-T-${s}`, `E2E-V-${s}`, o.total, o.cost, profit, margin, AT, String(CASHIER_ID), o.customerId ?? null],
  );
  return r[0].id as string;
}

async function insertPayment(
  db: DataSource,
  cid: number,
  invId: string,
  o: { method: 'CASH' | 'TRANSFER'; amount: number },
): Promise<string> {
  const r = await db.query(
    `INSERT INTO sale_payments
       (company_id, sale_invoice_id, payment_method, amount, change_amount,
        account_type, account_id, bank_name, is_voided, created_at, created_by_id)
     VALUES ($1,$2,$3::payment_method,$4,0,$5,1,$6,false,$7,$8) RETURNING id`,
    [String(cid), invId, o.method, o.amount, o.method === 'TRANSFER' ? 'bank' : 'cash_register', o.method === 'TRANSFER' ? 'Bancolombia' : null, AT, String(CASHIER_ID)],
  );
  return r[0].id as string;
}

async function insertCustomer(db: DataSource, cid: number, name: string): Promise<string> {
  const r = await db.query(`INSERT INTO customers (company_id, name) VALUES ($1,$2) RETURNING id`, [String(cid), name]);
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

/**
 * Inserta una nota (CREDIT=PARTIAL_VOID reduce; DEBIT=ADDITION suma) sobre una
 * venta, EXACTAMENTE como la deja UpdateSaleAction: crea credit_note +
 * credit_note_line y NO toca sale_credits.total_amount (así se comporta hoy).
 */
async function insertNote(
  db: DataSource,
  cid: number,
  invId: string,
  o: { noteType: 'CREDIT' | 'DEBIT'; total: number; cost: number },
): Promise<void> {
  const s = uniq();
  const prod = (
    await db.query(
      `INSERT INTO products (company_id, name, cost, stock, product_type, show_in_pos, is_purchasable, is_archived)
       VALUES ($1,$2,$3,0,'SIMPLE',true,false,false) RETURNING id`,
      [String(cid), `E2E-NOTE-PROD-${s}`, o.cost],
    )
  )[0].id;
  const op = o.noteType === 'CREDIT' ? 'PARTIAL_VOID' : 'ADDITION';
  const nid = (
    await db.query(
      `INSERT INTO credit_notes
         (company_id, sale_invoice_id, note_type, operation_type, note_number, total, is_deleted, created_at, created_by_id)
       VALUES ($1,$2,$3::note_type,$4::operation_type,$5,$6,false,$7,$8) RETURNING id`,
      [String(cid), invId, o.noteType, op, `E2E-NOTE-${s}`, o.total, AT, String(CASHIER_ID)],
    )
  )[0].id;
  await db.query(
    `INSERT INTO credit_note_lines (company_id, credit_note_id, product_id, description, unit_cost, quantity)
     VALUES ($1,$2,$3,$4,$5,1)`,
    [String(cid), nid, prod, `E2E-NOTE-line-${s}`, o.cost],
  );
}

async function wipeSales(db: DataSource, cid: number): Promise<void> {
  const c = String(cid);
  await db.query(`DELETE FROM credit_note_lines WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM credit_notes WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM sale_payments WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM sale_credits WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM sale_invoice_lines WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM sale_invoices WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM products WHERE company_id=$1`, [c]);
  await db.query(`DELETE FROM customers WHERE company_id=$1`, [c]);
}

let ds: DataSource | null = null;

describe('Mutaciones de crédito — cuadra al centavo (e2e pos_db)', () => {
  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) console.warn('[e2e] pos_db no disponible — credit-mutations-cuadra SKIPPED.');
  });
  afterAll(async () => {
    if (ds) await ds.destroy();
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
    if (!ds) return;
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

  const cmp = async (cid: number): Promise<{ sales: number; profit: number }> => {
    const m = await fetchDayMetricsMap(ds!, cid, RANGE_A, RANGE_B);
    const t = sumRangeTotals(m, [TODAY]);
    return { sales: t.sales, profit: t.profit };
  };

  // ── ANULAR PARCIAL (NC PARTIAL_VOID) sobre un crédito ─────────────────────
  it('ANULAR PARCIAL un crédito: TODOS los informes netean la NC (fuente = reporte de ventas)', async () => {
    await withCompany('__E2E_MUT_PARTIAL__', async (cid, a) => {
      const cust = await insertCustomer(ds!, cid, 'Cli PV');
      const inv = await insertSale(ds!, cid, { total: 20000, cost: 13000, customerId: cust }); // gan 7000
      await insertCredit(ds!, cid, inv, cust, { total: 20000 });
      // Anulación PARCIAL de 5000 (costo 3250 → nota gan 1750). Consolidado: 15000/9750/5250.
      await insertNote(ds!, cid, inv, { noteType: 'CREDIT', total: 5000, cost: 3250 });

      const NET_TOTAL = 15000;
      const NET_PROFIT = 5250;

      // FUENTE DE VERDAD: reporte de ventas netea la NC.
      const sr = (await a.sales.execute(cid, { dateFrom: TODAY, dateTo: TODAY }, actor(cid))).summary;
      expect(sr.total_revenue).toBe(NET_TOTAL);
      expect(sr.total_profit).toBe(NET_PROFIT);

      // Comparativa (netea notas).
      const c = await cmp(cid);
      expect(c.sales).toBe(NET_TOTAL);
      expect(c.profit).toBe(NET_PROFIT);

      // Los demás informes DEBEN cuadrar con el neto:
      const cl = await a.closure.execute(cid, TODAY);
      expect(cl.creditsBreakdown.newCreditsTotal).toBe(NET_TOTAL);
      expect(cl.creditsBreakdown.newCreditsProfit).toBe(NET_PROFIT);
      expect(cl.salesProfit).toBe(NET_PROFIT);

      const ext = await a.extended.execute(cid, TODAY, TODAY);
      expect(ext.ventas.credito).toBe(NET_TOTAL);
      expect(ext.ventas.creditoGanancia).toBe(NET_PROFIT);
      expect(ext.ventas.total).toBe(NET_TOTAL);
      expect(ext.ventas.ganancia).toBe(NET_PROFIT);

      const t = await a.today.execute(cid, TODAY);
      expect(t.totalSales).toBe(NET_TOTAL);
      expect(t.creditSales).toBe(NET_TOTAL);
      expect(t.salesProfit).toBe(NET_PROFIT);
      expect(t.newCredits.profit).toBe(NET_PROFIT);

      const ca = (await a.cashier.execute(cid, TODAY)).cashiers[0];
      expect(ca.creditSales).toBe(NET_TOTAL);
      expect(ca.creditProfit).toBe(NET_PROFIT);
      expect(ca.totalSales).toBe(NET_TOTAL);
      expect(round2(ca.cashProfit + ca.transferProfit + ca.creditProfit)).toBe(ca.profit);

      const rfm = await a.rfm.execute(cid, TODAY, TODAY);
      expect(rfm.customers[0].totalAmount).toBe(NET_TOTAL);
      expect(rfm.customers[0].totalProfit).toBe(NET_PROFIT);

      const perf = await a.perf.execute(cid, TODAY, TODAY);
      expect(perf.totals.sales).toBe(NET_TOTAL);
      expect(perf.totals.profit).toBe(NET_PROFIT);
    });
  });

  // ── ANULAR COMPLETO (is_deleted + NC FULL_VOID) ───────────────────────────
  it('ANULAR COMPLETO un crédito: desaparece de todos los informes de ventas', async () => {
    await withCompany('__E2E_MUT_FULL__', async (cid, a) => {
      const cust = await insertCustomer(ds!, cid, 'Cli FV');
      const inv = await insertSale(ds!, cid, { total: 18000, cost: 11000, customerId: cust });
      await insertCredit(ds!, cid, inv, cust, { total: 18000 });
      // Full void: VoidSaleAction marca is_deleted=true (+NC FULL_VOID). Simulamos el estado.
      await insertNote(ds!, cid, inv, { noteType: 'CREDIT', total: 18000, cost: 11000 });
      await ds!.query(`UPDATE sale_invoices SET is_deleted=true WHERE id=$1`, [inv]);

      const sr = (await a.sales.execute(cid, { dateFrom: TODAY, dateTo: TODAY }, actor(cid))).summary;
      expect(sr.total_revenue).toBe(0);
      expect(sr.total_profit).toBe(0);

      const cl = await a.closure.execute(cid, TODAY);
      expect(cl.creditsBreakdown.newCreditsTotal).toBe(0);
      expect(cl.salesProfit).toBe(0);
      const t = await a.today.execute(cid, TODAY);
      expect(t.totalSales).toBe(0);
      expect(t.salesProfit).toBe(0);
      const c = await cmp(cid);
      expect(c.sales).toBe(0);
      expect(c.profit).toBe(0);
    });
  });

  // ── EDITAR crédito: AÑADIR producto (ND ADDITION) ─────────────────────────
  it('EDITAR crédito añadiendo producto (ND): informes reflejan el consolidado (mayor)', async () => {
    await withCompany('__E2E_MUT_ADD__', async (cid, a) => {
      const cust = await insertCustomer(ds!, cid, 'Cli ADD');
      const inv = await insertSale(ds!, cid, { total: 20000, cost: 13000, customerId: cust }); // 7000
      await insertCredit(ds!, cid, inv, cust, { total: 20000 });
      // Añadir producto: ND ADDITION 6000 (costo 3500 → gan 2500). Consolidado 26000/16500/9500.
      await insertNote(ds!, cid, inv, { noteType: 'DEBIT', total: 6000, cost: 3500 });

      const NET_TOTAL = 26000;
      const NET_PROFIT = 9500;
      const sr = (await a.sales.execute(cid, { dateFrom: TODAY, dateTo: TODAY }, actor(cid))).summary;
      expect(sr.total_revenue).toBe(NET_TOTAL);
      expect(sr.total_profit).toBe(NET_PROFIT);
      const cl = await a.closure.execute(cid, TODAY);
      expect(cl.creditsBreakdown.newCreditsTotal).toBe(NET_TOTAL);
      expect(cl.creditsBreakdown.newCreditsProfit).toBe(NET_PROFIT);
      const t = await a.today.execute(cid, TODAY);
      expect(t.creditSales).toBe(NET_TOTAL);
      expect(t.salesProfit).toBe(NET_PROFIT);
      const c = await cmp(cid);
      expect(c.sales).toBe(NET_TOTAL);
      expect(c.profit).toBe(NET_PROFIT);
    });
  });

  // ── BORRAR abonos: devengado INVARIANTE, caja baja ────────────────────────
  it('BORRAR un abono y BORRAR todos: devengado invariante; caja baja; balance recomputado', async () => {
    await withCompany('__E2E_MUT_DELPAY__', async (cid, a) => {
      const cust = await insertCustomer(ds!, cid, 'Cli DEL');
      const inv = await insertSale(ds!, cid, { total: 30000, cost: 18000, customerId: cust }); // 12000
      await insertCredit(ds!, cid, inv, cust, { total: 30000, paid: 12000 });
      const p1 = await insertPayment(ds!, cid, inv, { method: 'CASH', amount: 7000 });
      await insertPayment(ds!, cid, inv, { method: 'TRANSFER', amount: 5000 });

      const before = await a.today.execute(cid, TODAY);
      expect(before.creditSales).toBe(30000);
      expect(before.salesProfit).toBe(12000);
      expect(before.creditPaymentsTotal).toBe(12000);

      // Borrar UN abono (el CASH de 7000).
      await ds!.query(`DELETE FROM sale_payments WHERE id=$1`, [p1]);
      await ds!.query(
        `UPDATE sale_credits sc SET paid_amount=p.s, balance=sc.total_amount-p.s,
           status=(CASE WHEN sc.total_amount-p.s<=0 THEN 'PAID' WHEN p.s>0 THEN 'PARTIALLY_PAID' ELSE 'PENDING' END)::credit_status
         FROM (SELECT COALESCE(SUM(amount),0) s FROM sale_payments WHERE sale_invoice_id=$1 AND is_voided=false) p
         WHERE sc.sale_invoice_id=$1`,
        [inv],
      );
      const mid = await a.today.execute(cid, TODAY);
      expect(mid.creditSales).toBe(30000); // devengado intacto
      expect(mid.salesProfit).toBe(12000);
      expect(mid.creditPaymentsTotal).toBe(5000); // solo queda el transfer

      // Borrar TODOS los abonos.
      await ds!.query(`DELETE FROM sale_payments WHERE sale_invoice_id=$1`, [inv]);
      await ds!.query(
        `UPDATE sale_credits SET paid_amount=0, balance=total_amount, status='PENDING' WHERE sale_invoice_id=$1`,
        [inv],
      );
      const after = await a.today.execute(cid, TODAY);
      expect(after.creditSales).toBe(30000); // devengado intacto
      expect(after.salesProfit).toBe(12000);
      expect(after.creditPaymentsTotal).toBe(0);
      const bal = await ds!.query(`SELECT balance,status FROM sale_credits WHERE sale_invoice_id=$1`, [inv]);
      expect(round2(Number(bal[0].balance))).toBe(30000);
      expect(bal[0].status).toBe('PENDING');
    });
  });
});
