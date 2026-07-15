import type { DataSource } from 'typeorm';

import { GetBreakEvenProgressAction } from '@/modules/dashboard/actions/get-break-even-progress.action';
import { Company } from '@/modules/companies/entities/company.entity';

import {
  cleanupCompany,
  createDisposableCompany,
  includeOrdersFlagStub,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL) — la "Meta del mes" (break-even) usa la utilidad COBRADA (base
 * caja): una venta a crédito aporta al progreso SOLO la utilidad proporcional a
 * lo que ya se abonó, NO su utilidad completa. Fiel a la caja: la plata no
 * cobrada no puede cubrir gastos ni cuenta para el punto de equilibrio.
 *
 * Fecha fija (Colombia) 2026-03-15.
 */

let seq = 0;

async function insertCreditSaleWithAbono(
  db: DataSource,
  companyId: number,
  opts: { total: number; cost: number; profit: number; abono: number; soldAtIso: string },
): Promise<void> {
  seq += 1;
  const suffix = `${Date.now()}-${seq}`;
  const inv = await db.query(
    `INSERT INTO sale_invoices
       (company_id, ticket_type, ticket_number, sale_number, total, cost, profit,
        is_deleted, sold_at, created_at, updated_at)
     VALUES ($1, 'SALE', $2, $3, $4, $5, $6, false, $7, $7, $7)
     RETURNING id`,
    [
      String(companyId),
      `E2E-BE-T-${suffix}`,
      `E2E-BE-V-${suffix}`,
      opts.total,
      opts.cost,
      opts.profit,
      opts.soldAtIso,
    ],
  );
  const customer = await db.query(
    `INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id`,
    [String(companyId), 'E2E BE Cliente'],
  );
  const balance = opts.total - opts.abono;
  await db.query(
    `INSERT INTO sale_credits
       (company_id, sale_invoice_id, customer_id, total_amount, paid_amount, balance, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'PARTIALLY_PAID'::credit_status)`,
    [String(companyId), inv[0].id, customer[0].id, opts.total, opts.abono, balance],
  );
  await db.query(
    `INSERT INTO sale_payments
       (company_id, sale_invoice_id, payment_method, amount, change_amount,
        account_type, account_id, is_voided, created_at)
     VALUES ($1, $2, 'CASH'::payment_method, $3, 0, 'cash_register', 1, false, $4)`,
    [String(companyId), inv[0].id, opts.abono, opts.soldAtIso],
  );
}

describe('Meta del mes (break-even) con ganancia cobrada (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;
  let action: GetBreakEvenProgressAction;

  const TODAY = '2026-03-15';
  const SOLD_TODAY = '2026-03-15T15:00:00.000Z';

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — break-even-canonical e2e SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, '__E2E_BREAK_EVEN_CANONICAL__');
    // Meta de 9000 en 30 días → cuota diaria 300.
    await ds.query(
      `UPDATE companies SET break_even_amount = 9000, break_even_period_days = 30 WHERE id = $1`,
      [String(companyId)],
    );
    action = new GetBreakEvenProgressAction(ds, ds.getRepository(Company), includeOrdersFlagStub(false));

    // Venta a CRÉDITO de hoy (total 300, utilidad 120) con un abono de 50.
    await insertCreditSaleWithAbono(ds, companyId, {
      total: 300,
      cost: 180,
      profit: 120,
      abono: 50,
      soldAtIso: SOLD_TODAY,
    });
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

  it('la venta a crédito aporta a la meta SOLO la utilidad cobrada (proporcional al abono)', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(companyId, TODAY);
    expect(res.configured).toBe(true);
    expect(res.dailyTarget).toBe(300); // 9000 / 30
    // Ganancia real cobrada del día = abono 50 · 120/300 = 20 (NO 120). La
    // utilidad restante (100) no está cobrada, no cuenta para la meta.
    expect(res.dayRealProfit).toBe(20);
    expect(res.monthRealProfit).toBe(20);
    // Progreso del mes = 20 / 9000 (redondeo a 4).
    expect(res.monthProgress).toBeCloseTo(0.0022, 4);
  });
});
