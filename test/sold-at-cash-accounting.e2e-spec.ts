import type { DataSource } from 'typeorm';

import { GetTodayAction } from '@/modules/dashboard/actions/get-today.action';
import { GetDailyClosureAction } from '@/modules/reports/actions/get-daily-closure.action';

import { cleanupCompany, createDisposableCompany, tryInitDataSource } from './helpers/e2e-db';

/**
 * E2E (BD REAL) de la contabilidad de caja por `sold_at`.
 *
 * Decisión de negocio: una venta se reconoce (Ventas del Día, GANANCIA, costo)
 * el día en que se REALIZA/COBRA (entra el dinero), NO el día en que se creó el
 * pedido. `ProcessPaymentAction` fija `sold_at = now()` al convertir ORDER →
 * SALE; los reportes de ventas del día filtran por `COALESCE(sold_at,
 * created_at)`.
 *
 * Aquí simulamos ese estado final insertando ventas SALE con `created_at` de un
 * día anterior pero `sold_at` = HOY (como lo dejaría el cobro de hoy), más su
 * `sale_payment` de hoy. Validamos que:
 *   - El "Resumen del día" (daily-closure) reconoce esas ventas y su ganancia
 *     HOY, y NO en su día de creación.
 *   - El dashboard `totalCollected` (por fecha de pago) y las ventas del cierre
 *     (por `sold_at`) CUADRAN.
 *   - Una venta de contado del MISMO día (sold_at ≈ created_at) no cambia.
 *
 * Fechas fijas (Colombia, para evitar flakiness):
 *   - "hoy"  = 2026-03-15  → [2026-03-15 05:00Z, 2026-03-16 04:59:59.999Z]
 *   - "ayer" = 2026-03-14
 */

let seq = 0;

async function insertSale(
  db: DataSource,
  companyId: number,
  opts: {
    createdAtIso: string;
    soldAtIso: string | null;
    total: number;
    cost: number;
    profit: number;
  },
): Promise<string> {
  seq += 1;
  const suffix = `${Date.now()}-${seq}`;
  const r = await db.query(
    `INSERT INTO sale_invoices
       (company_id, ticket_type, ticket_number, sale_number, total, cost, profit,
        is_deleted, sold_at, created_at, updated_at)
     VALUES ($1, 'SALE', $2, $3, $4, $5, $6, false, $7, $8, $8)
     RETURNING id`,
    [
      String(companyId),
      `E2E-SOLDAT-T-${suffix}`,
      `E2E-SOLDAT-V-${suffix}`,
      opts.total,
      opts.cost,
      opts.profit,
      opts.soldAtIso,
      opts.createdAtIso,
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

async function insertCustomer(db: DataSource, companyId: number, name: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [String(companyId), name],
  );
  return r[0].id as string;
}

/** Crédito PARCIALMENTE pagado sobre una venta (deja saldo vivo). */
async function insertSaleCredit(
  db: DataSource,
  companyId: number,
  saleInvoiceId: string,
  customerId: string,
  opts: { totalAmount: number; paidAmount: number },
): Promise<void> {
  const balance = opts.totalAmount - opts.paidAmount;
  const status =
    opts.paidAmount <= 0 ? 'PENDING' : balance <= 0 ? 'PAID' : 'PARTIALLY_PAID';
  await db.query(
    `INSERT INTO sale_credits
       (company_id, sale_invoice_id, customer_id, total_amount, paid_amount, balance, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::credit_status)`,
    [
      String(companyId),
      saleInvoiceId,
      customerId,
      opts.totalAmount,
      opts.paidAmount,
      balance,
      status,
    ],
  );
}

let noteSeq = 0;

/** Nota (CREDIT/DEBIT) aplicada a una venta regular. Sin líneas → costo 0. */
async function insertCreditNote(
  db: DataSource,
  companyId: number,
  saleInvoiceId: string,
  opts: { noteType: 'CREDIT' | 'DEBIT'; total: number },
): Promise<void> {
  noteSeq += 1;
  await db.query(
    `INSERT INTO credit_notes
       (company_id, sale_invoice_id, note_number, note_type, operation_type,
        subtotal, tax_total, total, is_deleted)
     VALUES ($1, $2, $3, $4::note_type, 'PARTIAL_VOID', $5, 0, $5, false)`,
    [
      String(companyId),
      saleInvoiceId,
      `E2E-NC-${Date.now()}-${noteSeq}`,
      opts.noteType,
      opts.total,
    ],
  );
}

/** Borra TODO el rastro financiero de una company desechable (orden FK-safe). */
async function purgeFinancials(db: DataSource, companyId: number): Promise<void> {
  const cid = String(companyId);
  await db.query(`DELETE FROM credit_notes WHERE company_id = $1`, [cid]);
  await db.query(`DELETE FROM sale_credits WHERE company_id = $1`, [cid]);
  await db.query(`DELETE FROM sale_payments WHERE company_id = $1`, [cid]);
  await db.query(`DELETE FROM sale_invoices WHERE company_id = $1`, [cid]);
  await db.query(`DELETE FROM customers WHERE company_id = $1`, [cid]);
}

describe('Contabilidad de caja por sold_at (daily-closure + dashboard, e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;
  let dashboard: GetTodayAction;
  let closure: GetDailyClosureAction;

  const TODAY = '2026-03-15';
  const YESTERDAY = '2026-03-14';

  // 10:00 Colombia del 15 (15:00Z). Mismo instante para sold_at y los pagos.
  const SOLD_TODAY = '2026-03-15T15:00:00.000Z';
  const CREATED_YESTERDAY = '2026-03-14T15:00:00.000Z';

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — sold-at-cash-accounting e2e SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, '__E2E_SOLD_AT_CASH_ACCOUNTING__');
    dashboard = new GetTodayAction(ds);
    closure = new GetDailyClosureAction(ds);

    // A: PEDIDO creado AYER, cobrado HOY en efectivo (contado).
    const a = await insertSale(ds, companyId, {
      createdAtIso: CREATED_YESTERDAY,
      soldAtIso: SOLD_TODAY,
      total: 100,
      cost: 60,
      profit: 40,
    });
    await insertPayment(ds, companyId, a, { method: 'CASH', amount: 100, createdAtIso: SOLD_TODAY });

    // B: PEDIDO creado AYER, cobrado HOY por transferencia (contado).
    const b = await insertSale(ds, companyId, {
      createdAtIso: CREATED_YESTERDAY,
      soldAtIso: SOLD_TODAY,
      total: 200,
      cost: 100,
      profit: 100,
    });
    await insertPayment(ds, companyId, b, {
      method: 'TRANSFER',
      amount: 200,
      createdAtIso: SOLD_TODAY,
      bankName: 'Bancolombia',
    });

    // C: venta de CONTADO del MISMO día (creada y cobrada HOY). No debe cambiar.
    const c = await insertSale(ds, companyId, {
      createdAtIso: '2026-03-15T16:00:00.000Z',
      soldAtIso: '2026-03-15T16:00:00.000Z',
      total: 50,
      cost: 30,
      profit: 20,
    });
    await insertPayment(ds, companyId, c, {
      method: 'CASH',
      amount: 50,
      createdAtIso: '2026-03-15T16:00:00.000Z',
    });
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

  it('HOY: el cierre reconoce las ventas por sold_at (pedidos de ayer cobrados hoy + contado hoy)', async () => {
    if (!ds) {
      return;
    }
    const res = await closure.execute(companyId, TODAY);
    // Ventas efectivo netas: A(100) + C(50) = 150 (B es transferencia).
    expect(res.cashSalesTotal).toBe(150);
    expect(res.salesBreakdown.grossSales).toBe(150);
    // Consignaciones (transferencia): B(200).
    expect(res.consignacionesVentas).toBe(200);
    // Ganancia de ventas del día: efectivo (150-90=60) + consig (200-100=100) = 160.
    expect(res.salesProfit).toBe(160);
  });

  it('AYER: el cierre NO reconoce esas ventas pese a que A/B se CREARON ayer', async () => {
    if (!ds) {
      return;
    }
    const res = await closure.execute(companyId, YESTERDAY);
    expect(res.cashSalesTotal).toBe(0);
    expect(res.consignacionesVentas).toBe(0);
    expect(res.salesProfit).toBe(0);
  });

  it('HOY: dashboard recauda y gana por el día del cobro (ganancia incluye pedidos de ayer)', async () => {
    if (!ds) {
      return;
    }
    const res = await dashboard.execute(companyId, TODAY);
    expect(res.cashSales).toBe(150);
    expect(res.transferSales).toBe(200);
    expect(res.totalCollected).toBe(350);
    // La GANANCIA del día ahora es por sold_at → incluye A(40)+B(100)+C(20)=160.
    expect(res.profit).toBe(160);
  });

  it('AYER: dashboard no recauda ni gana esos pedidos (sold_at cayó hoy)', async () => {
    if (!ds) {
      return;
    }
    const res = await dashboard.execute(companyId, YESTERDAY);
    expect(res.totalCollected).toBe(0);
    expect(res.profit).toBe(0);
  });

  it('CUADRE: dashboard.totalCollected == ventas del cierre (netCash + consignaciones)', async () => {
    if (!ds) {
      return;
    }
    const dash = await dashboard.execute(companyId, TODAY);
    const cierre = await closure.execute(companyId, TODAY);
    const ventasCierre = cierre.cashSalesTotal + cierre.consignacionesVentas;
    expect(dash.totalCollected).toBe(ventasCierre);
    expect(dash.totalCollected).toBe(350);
  });

  it('CONTADO mismo-día (C): sold_at ≈ created_at → cuenta HOY sin cambio', async () => {
    if (!ds) {
      return;
    }
    // Aislamos C creando una company solo con la venta de contado del mismo día.
    const soloCid = await createDisposableCompany(ds, '__E2E_SOLD_AT_SAME_DAY__');
    try {
      const c = await insertSale(ds, soloCid, {
        createdAtIso: '2026-03-15T16:00:00.000Z',
        soldAtIso: '2026-03-15T16:00:00.000Z',
        total: 50,
        cost: 30,
        profit: 20,
      });
      await insertPayment(ds, soloCid, c, {
        method: 'CASH',
        amount: 50,
        createdAtIso: '2026-03-15T16:00:00.000Z',
      });
      const cierre = await closure.execute(soloCid, TODAY);
      expect(cierre.cashSalesTotal).toBe(50);
      expect(cierre.salesProfit).toBe(20);
      const dash = await dashboard.execute(soloCid, TODAY);
      expect(dash.totalCollected).toBe(50);
      expect(dash.profit).toBe(20);
    } finally {
      await ds.query(`DELETE FROM sale_payments WHERE company_id = $1`, [String(soloCid)]);
      await ds.query(`DELETE FROM sale_invoices WHERE company_id = $1`, [String(soloCid)]);
      await cleanupCompany(ds, soloCid);
    }
  });

  it('CRÉDITO PARCIAL (pedido de ayer, abono hoy): crédito nuevo + conteo cuentan HOY (sold_at) y cuadran con el abono (sp.created_at)', async () => {
    if (!ds) {
      return;
    }
    // Pedido creado AYER, convertido a venta HOY (sold_at=hoy) y cobrado con un
    // abono PARCIAL hoy: total 300, abono 100 → queda crédito vivo de 200.
    const cid = await createDisposableCompany(ds, '__E2E_SOLD_AT_PARTIAL_CREDIT__');
    try {
      const customer = await insertCustomer(ds, cid, 'E2E Cliente Crédito');
      const inv = await insertSale(ds, cid, {
        createdAtIso: CREATED_YESTERDAY,
        soldAtIso: SOLD_TODAY,
        total: 300,
        cost: 180,
        profit: 120,
      });
      await insertSaleCredit(ds, cid, inv, customer, { totalAmount: 300, paidAmount: 100 });
      await insertPayment(ds, cid, inv, {
        method: 'CASH',
        amount: 100,
        createdAtIso: SOLD_TODAY,
      });

      const hoy = await dashboard.execute(cid, TODAY);
      // Crédito nuevo del día: se reconoce por sold_at → HOY (no por el día de creación).
      expect(hoy.newCredits.count).toBe(1);
      expect(hoy.newCredits.total).toBe(300);
      // Conteo de ventas: la V (aunque sea a crédito) cuenta por sold_at → HOY.
      expect(hoy.salesCount).toBe(1);
      // Recaudo del día = abono (por sp.created_at) → 100. No es venta regular (0),
      // así que todo el recaudo entra por creditPaymentsCash.
      expect(hoy.creditPaymentsCash).toBe(100);
      expect(hoy.totalCollected).toBe(100);
      // Ganancia = profit_share del abono = 100 * (120/300) = 40. Cuadra con el recaudo.
      expect(hoy.profit).toBe(40);

      // AYER (día de creación): NADA se reconoce — ni crédito nuevo, ni conteo, ni recaudo.
      const ayer = await dashboard.execute(cid, YESTERDAY);
      expect(ayer.newCredits.count).toBe(0);
      expect(ayer.newCredits.total).toBe(0);
      expect(ayer.salesCount).toBe(0);
      expect(ayer.totalCollected).toBe(0);
      expect(ayer.profit).toBe(0);
    } finally {
      await purgeFinancials(ds, cid);
      await cleanupCompany(ds, cid);
    }
  });

  it('NOTAS por sold_at: una NC sobre un pedido de ayer cobrado hoy ajusta las ventas de HOY, no de su día de creación', async () => {
    if (!ds) {
      return;
    }
    const cid = await createDisposableCompany(ds, '__E2E_SOLD_AT_NOTES__');
    try {
      // Venta regular creada AYER, realizada/cobrada HOY (sold_at=hoy), efectivo.
      const inv = await insertSale(ds, cid, {
        createdAtIso: CREATED_YESTERDAY,
        soldAtIso: SOLD_TODAY,
        total: 100,
        cost: 60,
        profit: 40,
      });
      await insertPayment(ds, cid, inv, {
        method: 'CASH',
        amount: 100,
        createdAtIso: SOLD_TODAY,
      });
      // NC de 30 sobre esa venta (sin líneas → costo 0).
      await insertCreditNote(ds, cid, inv, { noteType: 'CREDIT', total: 30 });

      // HOY: la venta y su NC se reconocen por sold_at → cashSales = 100 - 30 = 70.
      const hoy = await dashboard.execute(cid, TODAY);
      expect(hoy.cashSales).toBe(70);
      // Ganancia = profit V (40) - profit NC (30 - 0) = 10.
      expect(hoy.profit).toBe(10);

      // AYER (día de creación): ni la venta ni la NC se cuentan.
      const ayer = await dashboard.execute(cid, YESTERDAY);
      expect(ayer.cashSales).toBe(0);
      expect(ayer.profit).toBe(0);
    } finally {
      await purgeFinancials(ds, cid);
      await cleanupCompany(ds, cid);
    }
  });
});
