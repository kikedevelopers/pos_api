import type { DataSource } from 'typeorm';

import { GetTodayAction } from '@/modules/dashboard/actions/get-today.action';
import { GetDailyClosureAction } from '@/modules/reports/actions/get-daily-closure.action';
import { GetExtendedSummaryAction } from '@/modules/reports/actions/get-extended-summary.action';

import { cleanupCompany, createDisposableCompany, tryInitDataSource } from './helpers/e2e-db';

/**
 * E2E (BD REAL) — INVARIANTE ANTI-DIVERGENCIA: la "Ganancia del día" (headline)
 * es la MISMA en los tres endpoints que la exponen, sobre los mismos datos:
 *   `/dashboard/today`.profit === `/reports/daily-closure`.profit ===
 *   `/reports/extended-summary`.ventas.ganancia
 *
 * Es la utilidad COBRADA canónica (base caja): la porción de utilidad dentro del
 * dinero efectivamente recibido (contado + abonos proporcionales). Una venta a
 * crédito NO suma su ganancia hasta que se cobra. Antes cada endpoint la
 * calculaba distinto y divergían con abonos/pagos parciales.
 *
 * Fecha fija (Colombia) 2026-03-15; 15:00Z = 10:00 Colombia, dentro del día.
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
      `E2E-GC-T-${suffix}`,
      `E2E-GC-V-${suffix}`,
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
  opts: { method: 'CASH' | 'TRANSFER'; amount: number; createdAtIso: string },
): Promise<void> {
  await db.query(
    `INSERT INTO sale_payments
       (company_id, sale_invoice_id, payment_method, amount, change_amount,
        account_type, account_id, is_voided, created_at)
     VALUES ($1, $2, $3::payment_method, $4, 0, 'cash_register', 1, false, $5)`,
    [String(companyId), saleInvoiceId, opts.method, opts.amount, opts.createdAtIso],
  );
}

async function insertSaleCredit(
  db: DataSource,
  companyId: number,
  saleInvoiceId: string,
  opts: { totalAmount: number; paidAmount: number },
): Promise<void> {
  const customer = await db.query(
    `INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [String(companyId), 'E2E GC Cliente'],
  );
  const balance = opts.totalAmount - opts.paidAmount;
  const status = opts.paidAmount <= 0 ? 'PENDING' : balance <= 0 ? 'PAID' : 'PARTIALLY_PAID';
  await db.query(
    `INSERT INTO sale_credits
       (company_id, sale_invoice_id, customer_id, total_amount, paid_amount, balance, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::credit_status)`,
    [String(companyId), saleInvoiceId, customer[0].id, opts.totalAmount, opts.paidAmount, balance, status],
  );
}

describe('Ganancia del día canónica: misma en today, cierre y extended (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;
  let today: GetTodayAction;
  let closure: GetDailyClosureAction;
  let extended: GetExtendedSummaryAction;

  const DAY = '2026-03-15';
  const AT = '2026-03-15T15:00:00.000Z';

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — ganancia-canonica e2e SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, '__E2E_GANANCIA_CANONICA__');
    today = new GetTodayAction(ds);
    closure = new GetDailyClosureAction(ds);
    extended = new GetExtendedSummaryAction(ds);

    // Venta de CONTADO: total 100, utilidad 40, pagada en efectivo.
    const contado = await insertSale(ds, companyId, {
      total: 100,
      cost: 60,
      profit: 40,
      soldAtIso: AT,
    });
    await insertPayment(ds, companyId, contado, { method: 'CASH', amount: 100, createdAtIso: AT });

    // Venta a CRÉDITO: total 300, utilidad 120, con un abono parcial de 50 hoy.
    const credito = await insertSale(ds, companyId, {
      total: 300,
      cost: 180,
      profit: 120,
      soldAtIso: AT,
    });
    await insertSaleCredit(ds, companyId, credito, { totalAmount: 300, paidAmount: 50 });
    await insertPayment(ds, companyId, credito, { method: 'CASH', amount: 50, createdAtIso: AT });
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    await ds.query(`DELETE FROM sale_payments WHERE company_id = $1`, [String(companyId)]);
    await ds.query(`DELETE FROM sale_credits WHERE company_id = $1`, [String(companyId)]);
    await ds.query(`DELETE FROM customers WHERE company_id = $1`, [String(companyId)]);
    await ds.query(`DELETE FROM sale_invoices WHERE company_id = $1`, [String(companyId)]);
    await cleanupCompany(ds, companyId);
    await ds.destroy();
  });

  it('today.profit === cierre.profit === extended.ventas.ganancia === 60 (40 contado + 20 abono cobrado)', async () => {
    if (!ds) {
      return;
    }
    const [t, c, e] = await Promise.all([
      today.execute(companyId, DAY),
      closure.execute(companyId, DAY),
      extended.execute(companyId, DAY, DAY),
    ]);

    // Cobrado (base caja): contado 40 (pagado 100%) + abono 50·120/300 = 20 = 60.
    // La utilidad restante de la venta a crédito (100) NO se cuenta: no está
    // cobrada.
    expect(t.profit).toBe(60);
    expect(c.profit).toBe(60);
    expect(e.ventas.ganancia).toBe(60);
    // Invariante explícita.
    expect(t.profit).toBe(c.profit);
    expect(c.profit).toBe(e.ventas.ganancia);
  });

  it('los sub-bloques del cierre siguen siendo contado vs cartera (distintos del headline)', async () => {
    if (!ds) {
      return;
    }
    const c = await closure.execute(companyId, DAY);
    // "Ventas del día" (contado) = utilidad de la venta de contado = 40.
    expect(c.salesProfit).toBe(40);
    // "Recaudo de cartera" (abono proporcional) = 50 · 120/300 = 20.
    expect(c.creditsProfit).toBe(20);
  });
});
