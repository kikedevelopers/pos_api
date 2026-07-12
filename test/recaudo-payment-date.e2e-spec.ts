import type { DataSource } from 'typeorm';

import { GetTodayAction } from '@/modules/dashboard/actions/get-today.action';

import { cleanupCompany, createDisposableCompany, tryInitDataSource } from './helpers/e2e-db';

/**
 * E2E (BD REAL) del fix "Recaudo del día por FECHA DE PAGO".
 *
 * Bug: `/dashboard/today` medía el recaudo DIRECTO (pagos a ventas sin crédito)
 * por `si.created_at` (fecha de creación de la venta) en vez de `sp.created_at`
 * (fecha en que ENTRÓ el dinero). Un PEDIDO creado ayer y cobrado hoy caía en el
 * recaudo de AYER, mostrando $0 hoy pese a que el dinero entró hoy.
 *
 * Fix: `fetchPaymentsTotal` filtra SIEMPRE por `sp.created_at`.
 *
 * Además valida la unificación de zona horaria: los límites del día son días
 * CALENDARIO colombianos (America/Bogota), así un pago de la noche (≥19:00 Col,
 * ya en el día UTC siguiente) cae en el día colombiano correcto.
 *
 * Fechas de trabajo (fijas para evitar flakiness):
 *   - "hoy"    = 2026-03-15 (Colombia)  → [2026-03-15 05:00Z, 2026-03-16 04:59:59.999Z]
 *   - "ayer"   = 2026-03-14
 *   - "mañana" = 2026-03-16
 */

let seq = 0;

async function insertSale(
  db: DataSource,
  companyId: number,
  opts: { createdAtIso: string; total: number; cost: number; profit: number },
): Promise<string> {
  seq += 1;
  const suffix = `${Date.now()}-${seq}`;
  const r = await db.query(
    `INSERT INTO sale_invoices
       (company_id, ticket_type, ticket_number, sale_number, total, cost, profit, is_deleted, created_at, updated_at)
     VALUES ($1, 'SALE', $2, $3, $4, $5, $6, false, $7, $7)
     RETURNING id`,
    [
      String(companyId),
      `E2E-REC-T-${suffix}`,
      `E2E-REC-V-${suffix}`,
      opts.total,
      opts.cost,
      opts.profit,
      opts.createdAtIso,
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

describe('Recaudo del día por fecha de pago (dashboard/today, e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;
  let action: GetTodayAction;

  const TODAY = '2026-03-15';
  const YESTERDAY = '2026-03-14';
  const TOMORROW = '2026-03-16';

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — recaudo-payment-date e2e SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, '__E2E_RECAUDO_PAYMENT_DATE__');
    action = new GetTodayAction(ds);

    // si1: PEDIDO creado AYER, cobrado HOY en efectivo.
    const si1 = await insertSale(ds, companyId, {
      createdAtIso: '2026-03-14T15:00:00.000Z',
      total: 100,
      cost: 60,
      profit: 40,
    });
    await insertPayment(ds, companyId, si1, {
      method: 'CASH',
      amount: 100,
      createdAtIso: '2026-03-15T15:00:00.000Z', // 10:00 Colombia del 15
    });

    // si2: PEDIDO creado AYER, cobrado HOY por transferencia.
    const si2 = await insertSale(ds, companyId, {
      createdAtIso: '2026-03-14T15:00:00.000Z',
      total: 200,
      cost: 100,
      profit: 100,
    });
    await insertPayment(ds, companyId, si2, {
      method: 'TRANSFER',
      amount: 200,
      createdAtIso: '2026-03-15T15:00:00.000Z',
    });

    // si3: venta de CONTADO normal creada y pagada HOY (no debe cambiar).
    const si3 = await insertSale(ds, companyId, {
      createdAtIso: '2026-03-15T16:00:00.000Z',
      total: 50,
      cost: 30,
      profit: 20,
    });
    await insertPayment(ds, companyId, si3, {
      method: 'CASH',
      amount: 50,
      createdAtIso: '2026-03-15T16:00:00.000Z',
    });

    // si4: venta creada hace días, cobrada HOY de NOCHE (22:30 Colombia). En UTC
    // ese instante ya es 2026-03-16 03:30Z → debe caer en el 15 colombiano.
    const si4 = await insertSale(ds, companyId, {
      createdAtIso: '2026-03-10T15:00:00.000Z',
      total: 70,
      cost: 40,
      profit: 30,
    });
    await insertPayment(ds, companyId, si4, {
      method: 'CASH',
      amount: 70,
      createdAtIso: '2026-03-16T03:30:00.000Z', // 2026-03-15 22:30 Colombia
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

  it('HOY recauda por fecha de PAGO: incluye pedidos de días previos cobrados hoy', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(companyId, TODAY);
    // Efectivo: si1(100) + si3(50) + si4 nocturno(70) = 220.
    expect(res.cashSales).toBe(220);
    // Transferencia: si2(200).
    expect(res.transferSales).toBe(200);
    expect(res.totalCollected).toBe(420);
  });

  it('AYER NO recauda esos pagos aunque las ventas se CREARON ayer (fix del bug)', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(companyId, YESTERDAY);
    // Antes del fix, si1/si2 (creadas el 14) sumaban aquí. Ahora el dinero se
    // mide por la fecha del pago (el 15) → el 14 no recauda nada.
    expect(res.cashSales).toBe(0);
    expect(res.transferSales).toBe(0);
    expect(res.totalCollected).toBe(0);
  });

  it('zona Bogota: el pago nocturno (22:30 Col = 03:30Z del día siguiente) NO cae en MAÑANA', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(companyId, TOMORROW);
    // El pago de si4 pertenece al 15 colombiano, no al 16 (aunque su UTC sea 16).
    expect(res.cashSales).toBe(0);
    expect(res.totalCollected).toBe(0);
  });

  it('GANANCIA por fecha de PAGO (cobrada): fiel a la caja, cuadra con el recaudo', async () => {
    if (!ds) {
      return;
    }
    const res = await action.execute(companyId, TODAY);
    // Ganancia COBRADA (base caja): utilidad de los 4 pagos recibidos hoy =
    // 40 + 100 + 20 + 30 = 190. Va por `sp.created_at`, igual que el recaudo, así
    // que ambos son fieles a la caja (antes la ganancia iba por fecha de venta y
    // descuadraba con el recaudo).
    expect(res.profit).toBe(190);
    // Excedente/reinversión = recaudo (420) − utilidad cobrada (190) = 230 =
    // COGS de lo cobrado (60+100+30+40).
    expect(res.surplus).toBe(230);
  });
});
