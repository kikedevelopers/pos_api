import type { DataSource } from 'typeorm';

import type { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { GetConsolidatedInvoiceAction } from '@/modules/sales/actions/get-consolidated-invoice.action';
import { UpdateSaleAction, type UpdateSaleActor } from '@/modules/sales/actions/update-sale.action';
import type { UpdateSaleDto } from '@/modules/sales/dto/update-sale.dto';
import { getConsolidatedInvoice } from '@/modules/sales/internal/consolidate-invoice.helper';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';

import {
  cleanupCompany,
  createDisposableCompany,
  insertOwnerUser,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL pos_db) — Editar un CRÉDITO SIN ABONOS no mueve dinero.
 *
 * Bug: al editar una venta a crédito que no ha recibido ni un abono, el POS
 * pedía "Seleccionar Origen/Destino" y el backend sacaba de la caja (NC) o
 * metía a la caja (ND) un dinero que nunca existió.
 *
 * Regla fijada aquí:
 *   - Crédito SIN abonos → NC/ND sin movimiento de caja/banco ni SalePayment;
 *     cualquier `*_correction_source` se ignora; el SaleCredit se resincroniza
 *     con el consolidado (la diferencia la absorbe la deuda).
 *   - Crédito CON abono o venta de contado → comportamiento de siempre (la NC
 *     devuelve dinero por la cuenta elegida; la ND registra el cobro).
 *   - `GET /sales/:id/consolidated` expone `paid_amount`, `has_credit` e
 *     `is_unpaid_credit` para que el POS decida si abrir el modal.
 */

const COMPANY = '__E2E_EDIT_UNPAID_CREDIT__';
// El id real lo asigna `insertOwnerUser` (FK de cash_registers.user_id).
const ACTOR: UpdateSaleActor = { id: 0, fullName: 'E2E Owner', type: 'owner' };
const CASH = { type: 'cash_register' as const, id: 0, name: 'Mi Caja' };
// El id real lo asigna el seed (la edición mueve el saldo de la cuenta).
const BANK = { type: 'bank' as const, id: 0, name: 'BANCOLOMBIA' };
const INITIAL_BANK = 500000;
const INITIAL_CASH = 100000;

let seq = 0;
const uniq = (): string => `${Date.now()}-${(seq += 1)}`;

interface FinancialCall {
  amount: number;
  movement_type: string;
  concept: string;
}

describe('Editar crédito sin abonos — la corrección no mueve dinero (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let cid = 0;
  let customerId = '';
  let productA = '';
  let productB = '';
  let financialCalls: FinancialCall[] = [];
  let action: UpdateSaleAction;

  async function cashBalance(): Promise<number> {
    const r = await ds!.query(
      `SELECT balance::float AS b FROM cash_registers WHERE company_id = $1 AND user_id = $2`,
      [String(cid), String(ACTOR.id)],
    );
    return r[0] ? Number(r[0].b) : 0;
  }

  async function cashLogs(
    saleId: string,
  ): Promise<Array<{ type: string; direction: string; amount: number }>> {
    return ds!.query(
      `SELECT type, direction, amount::float AS amount FROM cash_register_logs
        WHERE company_id = $1 AND invoice_id = $2 ORDER BY id`,
      [String(cid), saleId],
    );
  }

  async function payments(
    saleId: string,
  ): Promise<Array<{ amount: number; credit_note_id: string | null }>> {
    return ds!.query(
      `SELECT amount::float AS amount, credit_note_id FROM sale_payments
        WHERE company_id = $1 AND sale_invoice_id = $2 AND is_voided = false ORDER BY id`,
      [String(cid), saleId],
    );
  }

  async function creditOf(saleId: string): Promise<{
    total_amount: number;
    paid_amount: number;
    balance: number;
    status: string;
  }> {
    const r = await ds!.query(
      `SELECT total_amount::float AS total_amount, paid_amount::float AS paid_amount,
              balance::float AS balance, status
         FROM sale_credits WHERE company_id = $1 AND sale_invoice_id = $2`,
      [String(cid), saleId],
    );
    return r[0];
  }

  async function notesOf(saleId: string): Promise<Array<{ note_type: string; total: number }>> {
    return ds!.query(
      `SELECT note_type, total::float AS total FROM credit_notes
        WHERE company_id = $1 AND sale_invoice_id = $2 ORDER BY id`,
      [String(cid), saleId],
    );
  }

  /**
   * Venta SALE de 2 líneas: A (1 × 4.300) + B (1 × 4.000) = 8.300, como la del
   * reporte. `credit` crea el SaleCredit; `paid` inserta un abono vivo.
   */
  async function seedSale(o: {
    credit: boolean;
    paid?: number;
    voidedPaid?: number;
    changeAmount?: number;
  }): Promise<string> {
    const s = uniq();
    const sale = await ds!.query(
      `INSERT INTO sale_invoices
         (company_id, ticket_type, ticket_number, sale_number, subtotal, tax_total, total, cost,
          profit, margin, is_deleted, customer_id, customer_name, created_by_id)
       VALUES ($1,'SALE',$2,$3,8300,0,8300,6300,2000,24.1,false,$4,'ALONSO REYES',$5) RETURNING id`,
      [String(cid), `E2E-T-${s}`, `E2E-V-${s}`, customerId, String(ACTOR.id)],
    );
    const saleId = sale[0].id as string;
    for (const l of [
      { productId: productA, description: 'FRUTA CRISTALIZADA', price: 4300, cost: 3300 },
      { productId: productB, description: 'ESENCIA PRODEN', price: 4000, cost: 3000 },
    ]) {
      await ds!.query(
        `INSERT INTO sale_invoice_lines
           (company_id, sale_invoice_id, product_id, description, quantity, unit_price, unit_cost, subtotal, total, packaging_value)
         VALUES ($1,$2,$3,$4,1,$5,$6,$5,$5,1)`,
        [String(cid), saleId, l.productId, l.description, l.price, l.cost],
      );
    }
    const insertPayment = async (amount: number, voided: boolean): Promise<void> => {
      await ds!.query(
        `INSERT INTO sale_payments
           (company_id, sale_invoice_id, payment_method, amount, change_amount,
            account_type, account_id, is_voided, created_by_id)
         VALUES ($1,$2,'CASH'::payment_method,$3,$4,'cash_register',0,$5,$6)`,
        [String(cid), saleId, amount, o.changeAmount ?? 0, voided, String(ACTOR.id)],
      );
    };
    if (o.paid) {
      await insertPayment(o.paid, false);
    }
    if (o.voidedPaid) {
      await insertPayment(o.voidedPaid, true);
    }
    if (o.credit) {
      const paid = o.paid ?? 0;
      await ds!.query(
        `INSERT INTO sale_credits
           (company_id, sale_invoice_id, customer_id, total_amount, paid_amount, balance, status)
         VALUES ($1,$2,$3,8300,$4,$5,$6)`,
        [
          String(cid),
          saleId,
          customerId,
          paid,
          8300 - paid,
          paid > 0 ? 'PARTIALLY_PAID' : 'PENDING',
        ],
      );
    }
    return saleId;
  }

  const line = (
    productId: string,
    name: string,
    price: number,
    cost: number,
    quantity: number,
  ) => ({
    item_id: Number(productId),
    name,
    price,
    cost,
    quantity,
    total: price * quantity,
  });

  /** Quita B (NC de 4.000) y manda caja como origen — como el modal del bug. */
  const removeBDto = (): UpdateSaleDto =>
    ({
      items: [line(productA, 'FRUTA CRISTALIZADA', 4300, 3300, 1)],
      total: 4300,
      cost: 3300,
      profit: 1000,
      margin: 23.26,
      credit_correction_source: CASH,
    }) as unknown as UpdateSaleDto;

  /** Sube A a 2 unidades (ND de 4.300) con caja como destino. */
  const addADto = (): UpdateSaleDto =>
    ({
      items: [
        line(productA, 'FRUTA CRISTALIZADA', 4300, 3300, 2),
        line(productB, 'ESENCIA PRODEN', 4000, 3000, 1),
      ],
      total: 12600,
      cost: 9600,
      profit: 3000,
      margin: 23.81,
      debit_correction_source: CASH,
    }) as unknown as UpdateSaleDto;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — edit-unpaid-credit e2e SKIPPED.');
      return;
    }
    cid = await createDisposableCompany(ds, COMPANY);
    ACTOR.id = await insertOwnerUser(ds, cid, 'edit_unpaid_credit');
    for (const [type, prefix] of [
      [TicketSettingType.CREDIT_NOTE, 'NC-'],
      [TicketSettingType.DEBIT_NOTE, 'ND-'],
    ] as const) {
      await ds.query(
        `INSERT INTO ticket_settings (company_id, ticket_type, current_number, prefix)
         VALUES ($1, $2, 0, $3) ON CONFLICT (company_id, ticket_type) DO NOTHING`,
        [String(cid), type, prefix],
      );
    }
    customerId = (
      await ds.query(
        `INSERT INTO customers (company_id, name) VALUES ($1,'ALONSO REYES') RETURNING id`,
        [String(cid)],
      )
    )[0].id;
    productA = await insertProduct(ds, cid, { name: 'FRUTA CRISTALIZADA', cost: 3300, stock: 50 });
    productB = await insertProduct(ds, cid, { name: 'ESENCIA PRODEN', cost: 3000, stock: 50 });
    await ds.query(`INSERT INTO cash_registers (company_id, user_id, balance) VALUES ($1,$2,$3)`, [
      String(cid),
      String(ACTOR.id),
      INITIAL_CASH,
    ]);
    BANK.id = Number(
      (
        await ds.query(
          `INSERT INTO banks (company_id, name, account_number, balance) VALUES ($1,'BANCOLOMBIA','1',$2) RETURNING id`,
          [String(cid), INITIAL_BANK],
        )
      )[0].id,
    );

    const financialStub = {
      record: (_m: unknown, p: FinancialCall) => {
        financialCalls.push({
          amount: p.amount,
          movement_type: p.movement_type,
          concept: p.concept,
        });
        return Promise.resolve(undefined);
      },
    } as unknown as FinancialMovementsService;
    action = new UpdateSaleAction(ds, new IncrementTicketNumberAction(), financialStub);
  });

  beforeEach(async () => {
    financialCalls = [];
    if (ds) {
      await ds.query(`UPDATE cash_registers SET balance = $2 WHERE company_id = $1`, [
        String(cid),
        INITIAL_CASH,
      ]);
    }
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    const c = String(cid);
    for (const table of [
      'cash_register_logs',
      'credit_note_lines',
      'credit_notes',
      'sale_payments',
      'sale_credits',
      'sale_status_history',
      'sale_invoice_lines',
      'sale_invoices',
      'cash_registers',
      'banks',
      'customers',
      'ticket_settings',
    ]) {
      await ds.query(`DELETE FROM ${table} WHERE company_id = $1`, [c]);
    }
    await cleanupCompany(ds, cid);
    await ds.destroy();
  });

  // ── Crédito SIN abonos ──────────────────────────────────────────────────

  it('NC sobre crédito sin abonos: no sale dinero de la caja aunque llegue cuenta origen; la deuda baja al consolidado', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: true });

    await action.execute(Number(saleId), removeBDto(), cid, ACTOR);

    expect(await notesOf(saleId)).toEqual([{ note_type: 'CREDIT', total: 4000 }]);
    expect(await cashBalance()).toBe(INITIAL_CASH);
    expect(await cashLogs(saleId)).toHaveLength(0);
    expect(financialCalls).toHaveLength(0);
    expect(await payments(saleId)).toHaveLength(0);
    expect(await creditOf(saleId)).toEqual({
      total_amount: 4300,
      paid_amount: 0,
      balance: 4300,
      status: 'PENDING',
    });
    // El inventario sí se devuelve: la NC es real, solo no mueve dinero.
    const stockB = await ds.query(`SELECT stock::float AS s FROM products WHERE id = $1`, [
      productB,
    ]);
    expect(Number(stockB[0].s)).toBe(51);
  });

  it('NC sobre crédito sin abonos con cuenta BANCO: tampoco registra egreso bancario', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: true });

    await action.execute(
      Number(saleId),
      { ...removeBDto(), credit_correction_source: BANK },
      cid,
      ACTOR,
    );

    expect(financialCalls).toHaveLength(0);
    expect(await cashLogs(saleId)).toHaveLength(0);
    expect((await creditOf(saleId)).balance).toBe(4300);
  });

  it('NC sin abonos NO falla aunque la caja no alcance (antes: INSUFFICIENT_REGISTER_BALANCE)', async () => {
    if (!ds) {
      return;
    }
    await ds.query(`UPDATE cash_registers SET balance = 0 WHERE company_id = $1`, [String(cid)]);
    const saleId = await seedSale({ credit: true });

    await expect(action.execute(Number(saleId), removeBDto(), cid, ACTOR)).resolves.toBeDefined();
    expect(await cashBalance()).toBe(0);
  });

  it('ND sobre crédito sin abonos: no entra dinero ni se registra pago; la deuda sube al consolidado', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: true });

    await action.execute(Number(saleId), addADto(), cid, ACTOR);

    expect(await notesOf(saleId)).toEqual([{ note_type: 'DEBIT', total: 4300 }]);
    expect(await cashBalance()).toBe(INITIAL_CASH);
    expect(await cashLogs(saleId)).toHaveLength(0);
    expect(await payments(saleId)).toHaveLength(0);
    expect(financialCalls).toHaveLength(0);
    expect(await creditOf(saleId)).toEqual({
      total_amount: 12600,
      paid_amount: 0,
      balance: 12600,
      status: 'PENDING',
    });
  });

  it('NC + ND en la misma edición sobre crédito sin abonos: sin dinero; deuda = consolidado neto', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: true });
    const dto = {
      // quita B (−4.000) y sube A a 3 (+8.600) → consolidado 12.900
      items: [line(productA, 'FRUTA CRISTALIZADA', 4300, 3300, 3)],
      total: 12900,
      cost: 9900,
      profit: 3000,
      margin: 23.26,
      credit_correction_source: CASH,
      debit_correction_source: CASH,
    } as unknown as UpdateSaleDto;

    await action.execute(Number(saleId), dto, cid, ACTOR);

    expect(await notesOf(saleId)).toEqual([
      { note_type: 'CREDIT', total: 4000 },
      { note_type: 'DEBIT', total: 8600 },
    ]);
    expect(await cashLogs(saleId)).toHaveLength(0);
    expect(await payments(saleId)).toHaveLength(0);
    expect((await creditOf(saleId)).balance).toBe(12900);
    const consolidated = await getConsolidatedInvoice(ds.manager, cid, Number(saleId));
    expect(consolidated?.total).toBe(12900);
  });

  it('edición que remueve TODO un crédito sin abonos: anula la venta sin mover dinero y sin tocar el crédito (CHECK total>0)', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: true });
    const dto = {
      items: [],
      total: 0,
      cost: 0,
      profit: 0,
      margin: 0,
      credit_correction_source: CASH,
    } as unknown as UpdateSaleDto;

    await action.execute(Number(saleId), dto, cid, ACTOR);

    const sale = await ds.query(`SELECT is_deleted FROM sale_invoices WHERE id = $1`, [saleId]);
    expect(sale[0].is_deleted).toBe(true);
    expect(await cashLogs(saleId)).toHaveLength(0);
    expect(await cashBalance()).toBe(INITIAL_CASH);
    expect((await creditOf(saleId)).total_amount).toBe(8300);
  });

  it('un abono REVERSADO (is_voided) no cuenta: sigue siendo crédito sin abonos', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: true, voidedPaid: 3000 });

    await action.execute(Number(saleId), removeBDto(), cid, ACTOR);

    expect(await cashLogs(saleId)).toHaveLength(0);
    expect(await cashBalance()).toBe(INITIAL_CASH);
    expect((await creditOf(saleId)).balance).toBe(4300);
  });

  // ── Crédito CON abono parcial: la NC baja la deuda primero ──────────────

  it('NC sobre crédito con abono MENOR al nuevo total: no devuelve dinero; la deuda baja', async () => {
    if (!ds) {
      return;
    }
    // 8.300 con abono de 2.000; quitar B (4.000) → nuevo total 4.300 ≥ 2.000.
    const saleId = await seedSale({ credit: true, paid: 2000 });

    await action.execute(Number(saleId), removeBDto(), cid, ACTOR);

    expect(await cashLogs(saleId)).toHaveLength(0);
    expect(await cashBalance()).toBe(INITIAL_CASH);
    expect(financialCalls).toHaveLength(0);
    expect(await creditOf(saleId)).toEqual({
      total_amount: 4300,
      paid_amount: 2000,
      balance: 2300,
      status: 'PARTIALLY_PAID',
    });
  });

  it('NC sobre crédito con abono MAYOR al nuevo total: devuelve SOLO el excedente por la caja y el crédito queda PAGADO', async () => {
    if (!ds) {
      return;
    }
    // abono 6.000; nuevo total 4.300 → se devuelven 1.700 (no los 4.000 de la NC).
    const saleId = await seedSale({ credit: true, paid: 6000 });

    await action.execute(Number(saleId), removeBDto(), cid, ACTOR);

    expect(await cashLogs(saleId)).toEqual([
      { type: 'CREDIT_NOTE_PARTIAL_VOID', direction: 'OUT', amount: 1700 },
    ]);
    expect(await cashBalance()).toBe(INITIAL_CASH - 1700);
    expect(await creditOf(saleId)).toEqual({
      total_amount: 4300,
      paid_amount: 4300,
      balance: 0,
      status: 'PAID',
    });
  });

  it('NC con excedente y cuenta BANCO: el egreso bancario es solo el excedente', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: true, paid: 6000 });

    await action.execute(
      Number(saleId),
      { ...removeBDto(), credit_correction_source: BANK },
      cid,
      ACTOR,
    );

    expect(financialCalls).toEqual([
      { amount: 1700, movement_type: 'EXPENSE', concept: 'CREDIT_NOTE_REFUND' },
    ]);
    // El saldo del banco baja de verdad (no solo el movimiento).
    const bank: Array<{ b: number }> = await ds.query(
      `SELECT balance::float AS b FROM banks WHERE id = $1`,
      [BANK.id],
    );
    expect(Number(bank[0].b)).toBe(INITIAL_BANK - 1700);
    await ds.query(`UPDATE banks SET balance = $2 WHERE id = $1`, [BANK.id, INITIAL_BANK]);
  });

  it('abono que iguala el nuevo total: no devuelve nada y el crédito queda PAGADO', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: true, paid: 4300 });

    await action.execute(Number(saleId), removeBDto(), cid, ACTOR);

    expect(await cashLogs(saleId)).toHaveLength(0);
    expect(await creditOf(saleId)).toEqual({
      total_amount: 4300,
      paid_amount: 4300,
      balance: 0,
      status: 'PAID',
    });
  });

  it('ND sobre crédito con abono: no entra dinero ni se registra pago; la deuda sube', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: true, paid: 2000 });

    await action.execute(Number(saleId), addADto(), cid, ACTOR);

    expect(await cashLogs(saleId)).toHaveLength(0);
    expect(await cashBalance()).toBe(INITIAL_CASH);
    expect(await payments(saleId)).toHaveLength(1); // solo el abono original
    expect(await creditOf(saleId)).toEqual({
      total_amount: 12600,
      paid_amount: 2000,
      balance: 10600,
      status: 'PARTIALLY_PAID',
    });
  });

  it('edición que remueve TODO un crédito con abono: devuelve exactamente lo abonado', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: true, paid: 6000 });
    const dto = {
      items: [],
      total: 0,
      cost: 0,
      profit: 0,
      margin: 0,
      credit_correction_source: CASH,
    } as unknown as UpdateSaleDto;

    await action.execute(Number(saleId), dto, cid, ACTOR);

    expect(await cashLogs(saleId)).toEqual([
      { type: 'CREDIT_NOTE_FULL_VOID', direction: 'OUT', amount: 6000 },
    ]);
    const sale = await ds.query(`SELECT is_deleted FROM sale_invoices WHERE id = $1`, [saleId]);
    expect(sale[0].is_deleted).toBe(true);
  });

  // ── Contado: comportamiento de siempre (sin regresión) ─────────────────

  it('venta de CONTADO (sin crédito): la NC devuelve dinero por la caja', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: false, paid: 8300 });

    await action.execute(Number(saleId), removeBDto(), cid, ACTOR);

    expect(await cashLogs(saleId)).toEqual([
      { type: 'CREDIT_NOTE_PARTIAL_VOID', direction: 'OUT', amount: 4000 },
    ]);
    expect(await cashBalance()).toBe(INITIAL_CASH - 4000);
  });

  it('venta de CONTADO: la ND sin cuenta explícita cae en la caja del actor (default intacto)', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedSale({ credit: false, paid: 8300 });
    const dto = { ...addADto(), debit_correction_source: undefined } as UpdateSaleDto;

    await action.execute(Number(saleId), dto, cid, ACTOR);

    expect(await cashLogs(saleId)).toEqual([{ type: 'DEBIT_NOTE', direction: 'IN', amount: 4300 }]);
  });

  // ── GET /sales/:id/consolidated expone el estado de cobro ───────────────

  describe('GetConsolidatedInvoiceAction — estado de cobro', () => {
    it('crédito sin abonos → is_unpaid_credit = true', async () => {
      if (!ds) {
        return;
      }
      const saleId = await seedSale({ credit: true });
      const r = await new GetConsolidatedInvoiceAction(ds).execute(Number(saleId), cid);
      expect(r).toMatchObject({
        total: 8300,
        paid_amount: 0,
        has_credit: true,
        is_unpaid_credit: true,
      });
    });

    it('crédito con abono → is_unpaid_credit = false y paid_amount = abono', async () => {
      if (!ds) {
        return;
      }
      const saleId = await seedSale({ credit: true, paid: 2000 });
      const r = await new GetConsolidatedInvoiceAction(ds).execute(Number(saleId), cid);
      expect(r).toMatchObject({ paid_amount: 2000, has_credit: true, is_unpaid_credit: false });
    });

    it('contado con vuelto → paid_amount neto (amount − change), sin crédito', async () => {
      if (!ds) {
        return;
      }
      const saleId = await seedSale({ credit: false, paid: 10000, changeAmount: 1700 });
      const r = await new GetConsolidatedInvoiceAction(ds).execute(Number(saleId), cid);
      expect(r).toMatchObject({ paid_amount: 8300, has_credit: false, is_unpaid_credit: false });
    });

    it('abono reversado no cuenta como pagado', async () => {
      if (!ds) {
        return;
      }
      const saleId = await seedSale({ credit: true, voidedPaid: 3000 });
      const r = await new GetConsolidatedInvoiceAction(ds).execute(Number(saleId), cid);
      expect(r).toMatchObject({ paid_amount: 0, is_unpaid_credit: true });
    });

    it('venta inexistente → null', async () => {
      if (!ds) {
        return;
      }
      expect(await new GetConsolidatedInvoiceAction(ds).execute(987654321, cid)).toBeNull();
    });

    it('no expone los snapshots internos de empaque', async () => {
      if (!ds) {
        return;
      }
      const saleId = await seedSale({ credit: true });
      const r = await new GetConsolidatedInvoiceAction(ds).execute(Number(saleId), cid);
      expect(r?.lines[0]).not.toHaveProperty('packaging_value');
    });
  });
});
