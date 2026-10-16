import type { DataSource } from 'typeorm';

import { ProcessCreditPaymentAction } from '@/modules/credits/actions/process-credit-payment.action';
import type { ProcessCreditPaymentDto } from '@/modules/credits/dto/process-credit-payment.dto';
import { ListFinancialMovementsAction } from '@/modules/financial-movements/actions/list-financial-movements.action';
import { RecordFinancialMovementAction } from '@/modules/financial-movements/actions/record-financial-movement.action';
import { FinancialMovement } from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { DeleteSalePaymentAction } from '@/modules/sales/actions/delete-sale-payment.action';
import { UpdateSaleAction, type UpdateSaleActor } from '@/modules/sales/actions/update-sale.action';
import { VoidSaleAction } from '@/modules/sales/actions/void-sale.action';
import type { UpdateSaleDto } from '@/modules/sales/dto/update-sale.dto';
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
 * E2E (BD REAL pos_db) — Reversar ABONOS de un crédito y anular después.
 *
 * Reportado: en una venta de contado el admin puede eliminar un pago, pero en
 * un crédito el botón no aparecía. El reverso de un abono debe dejar el
 * registro IGUAL que el de un pago de venta: el dinero sale de la cuenta
 * ORIGINAL (caja o banco), el pago queda anulado (soft-delete) y el crédito se
 * recalcula. Y tras reversar todos los abonos, anular la venta NO debe pedir
 * ni hacer ninguna devolución (el dinero ya se devolvió).
 *
 * Los abonos se crean con la acción REAL de abono (`ProcessCreditPaymentAction`).
 */

const COMPANY = '__E2E_CREDIT_PAYMENT_REVERSAL__';
const ACTOR: UpdateSaleActor = { id: 0, fullName: 'E2E Admin', type: 'owner' };
const CASH_START = 100000;
const BANK_START = 500000;

describe('Reversar abonos de un crédito y anularlo (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let cid = 0;
  let customerId = '';
  let productId = '';
  let registerId = '';
  let bankId = 0;
  let seq = 0;
  let creditPayment: ProcessCreditPaymentAction;
  let deletePayment: DeleteSalePaymentAction;
  let voidSale: VoidSaleAction;
  let updateSale: UpdateSaleAction;

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ds!.query(sql, params);

  const cashBalance = async (): Promise<number> =>
    Number(
      (
        await q<{ b: number }>(`SELECT balance::float AS b FROM cash_registers WHERE id = $1`, [
          registerId,
        ])
      )[0].b,
    );
  const bankBalance = async (): Promise<number> =>
    Number(
      (await q<{ b: number }>(`SELECT balance::float AS b FROM banks WHERE id = $1`, [bankId]))[0]
        .b,
    );

  async function creditOf(saleId: string) {
    return (
      await q<{ total_amount: number; paid_amount: number; balance: number; status: string }>(
        `SELECT total_amount::float AS total_amount, paid_amount::float AS paid_amount,
                balance::float AS balance, status FROM sale_credits WHERE sale_invoice_id = $1`,
        [saleId],
      )
    )[0];
  }

  async function livePayments(saleId: string) {
    return q<{ id: string; amount: number; payment_method: string }>(
      `SELECT id, amount::float AS amount, payment_method FROM sale_payments
        WHERE sale_invoice_id = $1 AND is_voided = false ORDER BY id`,
      [saleId],
    );
  }

  /** Crédito sin abonos por 8.300 (1 línea), como lo deja el cobro a crédito. */
  async function seedCredit(total = 8300): Promise<string> {
    seq += 1;
    const s = `${Date.now()}-${seq}`;
    const saleId = (
      await q<{ id: string }>(
        `INSERT INTO sale_invoices
           (company_id, ticket_type, ticket_number, sale_number, subtotal, tax_total, total, cost,
            profit, margin, is_deleted, customer_id, customer_name, created_by_id)
         VALUES ($1,'SALE',$2,$3,$4,0,$4,0,0,0,false,$5,'Maritza Rodríguez',$6) RETURNING id`,
        [String(cid), `PED-${s}`, `VTA-${s}`, total, customerId, String(ACTOR.id)],
      )
    )[0].id;
    await q(
      `INSERT INTO sale_invoice_lines
         (company_id, sale_invoice_id, product_id, description, quantity, unit_price, unit_cost, subtotal, total, packaging_value)
       VALUES ($1,$2,$3,'BOLSA MANIJA 1K UND',1,$4,1000,$4,$4,1)`,
      [String(cid), saleId, productId, total],
    );
    await q(
      `INSERT INTO sale_credits (company_id, sale_invoice_id, customer_id, total_amount, paid_amount, balance, status)
       VALUES ($1,$2,$3,$4,0,$4,'PENDING')`,
      [String(cid), saleId, customerId, total],
    );
    return saleId;
  }

  async function abonar(
    saleId: string,
    method: 'CASH' | 'TRANSFER',
    amount: number,
  ): Promise<void> {
    const r = await creditPayment.execute(
      {
        invoice_id: Number(saleId),
        payment_method: method,
        amount,
        bank_id: method === 'TRANSFER' ? bankId : null,
        bank_name: method === 'TRANSFER' ? 'BANCOLOMBIA' : null,
      } as unknown as ProcessCreditPaymentDto,
      cid,
      { id: ACTOR.id, fullName: ACTOR.fullName } as never,
    );
    expect(r.success).toBe(true);
  }

  const reverse = (saleId: string, paymentId: string) =>
    deletePayment.execute(
      Number(saleId),
      Number(paymentId),
      cid,
      ACTOR,
      'Abono registrado por error',
    );

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — credit-payment-reversal e2e SKIPPED.');
      return;
    }
    cid = await createDisposableCompany(ds, COMPANY);
    ACTOR.id = await insertOwnerUser(ds, cid, 'credit_reversal');
    for (const [type, prefix] of [
      [TicketSettingType.CREDIT_NOTE, 'NC-'],
      [TicketSettingType.DEBIT_NOTE, 'ND-'],
    ] as const) {
      await q(
        `INSERT INTO ticket_settings (company_id, ticket_type, current_number, prefix)
         VALUES ($1,$2,0,$3) ON CONFLICT (company_id, ticket_type) DO NOTHING`,
        [String(cid), type, prefix],
      );
    }
    customerId = (
      await q<{ id: string }>(
        `INSERT INTO customers (company_id, name) VALUES ($1,'Maritza Rodríguez') RETURNING id`,
        [String(cid)],
      )
    )[0].id;
    productId = await insertProduct(ds, cid, {
      name: 'BOLSA MANIJA 1K UND',
      cost: 1000,
      stock: 100,
    });
    registerId = (
      await q<{ id: string }>(
        `INSERT INTO cash_registers (company_id, user_id, balance) VALUES ($1,$2,$3) RETURNING id`,
        [String(cid), String(ACTOR.id), CASH_START],
      )
    )[0].id;
    bankId = Number(
      (
        await q<{ id: string }>(
          `INSERT INTO banks (company_id, name, account_number, balance) VALUES ($1,'BANCOLOMBIA','123',$2) RETURNING id`,
          [String(cid), BANK_START],
        )
      )[0].id,
    );

    const financial = new FinancialMovementsService(
      new ListFinancialMovementsAction(ds.getRepository(FinancialMovement)),
      new RecordFinancialMovementAction(),
    );
    creditPayment = new ProcessCreditPaymentAction(ds, financial);
    deletePayment = new DeleteSalePaymentAction(ds, financial);
    voidSale = new VoidSaleAction(ds, new IncrementTicketNumberAction(), financial);
    updateSale = new UpdateSaleAction(ds, new IncrementTicketNumberAction(), financial);
  });

  beforeEach(async () => {
    if (!ds) {
      return;
    }
    await q(`UPDATE cash_registers SET balance = $2 WHERE id = $1`, [registerId, CASH_START]);
    await q(`UPDATE banks SET balance = $2 WHERE id = $1`, [bankId, BANK_START]);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    const c = String(cid);
    for (const table of [
      'financial_movements',
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
      await q(`DELETE FROM ${table} WHERE company_id = $1`, [c]);
    }
    await cleanupCompany(ds, cid);
    await ds.destroy();
  });

  // ── Reverso de abonos ─────────────────────────────────────────────────

  it('abono en EFECTIVO: sale de la caja original, queda anulado y el crédito vuelve a PENDIENTE', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await abonar(saleId, 'CASH', 3000);
    expect(await cashBalance()).toBe(CASH_START + 3000);
    const [pay] = await livePayments(saleId);

    const r = await reverse(saleId, pay.id);

    expect(r).toMatchObject({
      success: true,
      reversed_amount: 3000,
      sale_balance: 8300,
      credit_status: 'PENDING',
    });
    expect(await cashBalance()).toBe(CASH_START);
    expect(await livePayments(saleId)).toHaveLength(0);
    expect(await creditOf(saleId)).toEqual({
      total_amount: 8300,
      paid_amount: 0,
      balance: 8300,
      status: 'PENDING',
    });
    const voided = await q<{ is_voided: boolean; void_reason: string; voided_by: string }>(
      `SELECT is_voided, void_reason, voided_by FROM sale_payments WHERE id = $1`,
      [pay.id],
    );
    expect(voided[0]).toEqual({
      is_voided: true,
      void_reason: 'Abono registrado por error',
      voided_by: 'E2E Admin',
    });
    // Rastro de caja: entrada del abono + salida del reverso, ambas ligadas al pago.
    const logs = await q<{
      type: string;
      direction: string;
      amount: number;
      is_credit_related: boolean;
    }>(
      `SELECT type, direction, amount::float AS amount, is_credit_related FROM cash_register_logs
        WHERE payment_id = $1 ORDER BY id`,
      [pay.id],
    );
    expect(logs).toEqual([
      { type: 'CREDIT_PAYMENT', direction: 'IN', amount: 3000, is_credit_related: true },
      { type: 'PAYMENT_REVERSAL', direction: 'OUT', amount: 3000, is_credit_related: true },
    ]);
  });

  it('abono por TRANSFERENCIA: sale del banco original con su movimiento EXPENSE PAYMENT_REVERSAL', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await abonar(saleId, 'TRANSFER', 5000);
    expect(await bankBalance()).toBe(BANK_START + 5000);
    const [pay] = await livePayments(saleId);

    await reverse(saleId, pay.id);

    expect(await bankBalance()).toBe(BANK_START);
    expect(await creditOf(saleId)).toMatchObject({
      paid_amount: 0,
      balance: 8300,
      status: 'PENDING',
    });
    const mov = await q<{
      movement_type: string;
      concept: string;
      amount: number;
      source_id: string;
    }>(
      `SELECT movement_type, concept, amount::float AS amount, source_id FROM financial_movements
        WHERE company_id = $1 AND concept = 'PAYMENT_REVERSAL' ORDER BY id DESC LIMIT 1`,
      [String(cid)],
    );
    expect(mov[0]).toEqual({
      movement_type: 'EXPENSE',
      concept: 'PAYMENT_REVERSAL',
      amount: 5000,
      source_id: String(bankId),
    });
  });

  it('crédito PAGADO con dos abonos: reversar uno lo deja PARCIAL; reversar el otro, PENDIENTE', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await abonar(saleId, 'CASH', 3300);
    await abonar(saleId, 'TRANSFER', 5000);
    expect((await creditOf(saleId)).status).toBe('PAID');
    const [cashPay, bankPay] = await livePayments(saleId);

    await reverse(saleId, bankPay.id);
    expect(await creditOf(saleId)).toEqual({
      total_amount: 8300,
      paid_amount: 3300,
      balance: 5000,
      status: 'PARTIALLY_PAID',
    });

    await reverse(saleId, cashPay.id);
    expect(await creditOf(saleId)).toEqual({
      total_amount: 8300,
      paid_amount: 0,
      balance: 8300,
      status: 'PENDING',
    });
    expect(await cashBalance()).toBe(CASH_START);
    expect(await bankBalance()).toBe(BANK_START);
  });

  it('reversar dos veces el mismo abono es idempotente (no descuenta la caja dos veces)', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await abonar(saleId, 'CASH', 3000);
    const [pay] = await livePayments(saleId);

    await reverse(saleId, pay.id);
    const again = await reverse(saleId, pay.id);

    expect(again.replay).toBe(true);
    expect(await cashBalance()).toBe(CASH_START);
  });

  it('caja sin fondos para el reverso → 422 y NADA cambia (rollback total)', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await abonar(saleId, 'CASH', 3000);
    await q(`UPDATE cash_registers SET balance = 1000 WHERE id = $1`, [registerId]);
    const [pay] = await livePayments(saleId);

    await expect(reverse(saleId, pay.id)).rejects.toMatchObject({
      response: { payload: { code: 'INSUFFICIENT_REGISTER_BALANCE' } },
    });
    expect(await cashBalance()).toBe(1000);
    expect(await livePayments(saleId)).toHaveLength(1);
    expect((await creditOf(saleId)).paid_amount).toBe(3000);
  });

  it('crédito EDITADO (NC): reversar un abono conserva el total consolidado, no el original', async () => {
    if (!ds) {
      return;
    }
    // 8.300 → editado a 4.300 (sin abonos: la deuda baja), luego abona 2.000.
    const saleId = await seedCredit();
    await updateSale.execute(
      Number(saleId),
      {
        items: [
          {
            item_id: Number(productId),
            name: 'BOLSA MANIJA 1K UND',
            cost: 1000,
            price: 4300,
            quantity: 1,
            total: 4300,
          },
        ],
        total: 4300,
        cost: 1000,
        profit: 3300,
        margin: 76.74,
      } as unknown as UpdateSaleDto,
      cid,
      ACTOR,
    );
    expect((await creditOf(saleId)).total_amount).toBe(4300);
    await abonar(saleId, 'CASH', 2000);
    const [pay] = await livePayments(saleId);

    await reverse(saleId, pay.id);

    expect(await creditOf(saleId)).toEqual({
      total_amount: 4300,
      paid_amount: 0,
      balance: 4300,
      status: 'PENDING',
    });
  });

  // ── Anular después de reversar ────────────────────────────────────────

  it('tras reversar TODOS los abonos (efectivo + transferencia), anular NO pide devolución ni mueve dinero', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await abonar(saleId, 'CASH', 3300);
    await abonar(saleId, 'TRANSFER', 5000);
    for (const p of await livePayments(saleId)) {
      await reverse(saleId, p.id);
    }
    const cashBefore = await cashBalance();
    const bankBefore = await bankBalance();

    // Sin refund_source (como lo envía el TicketViewer).
    await voidSale.execute(Number(saleId), cid, ACTOR, null, null);

    const sale = await q<{ is_deleted: boolean }>(
      `SELECT is_deleted FROM sale_invoices WHERE id = $1`,
      [saleId],
    );
    expect(sale[0].is_deleted).toBe(true);
    expect(await cashBalance()).toBe(cashBefore);
    expect(await bankBalance()).toBe(bankBefore);
    const voidLogs = await q(
      `SELECT id FROM cash_register_logs WHERE invoice_id = $1 AND type = 'CREDIT_NOTE_FULL_VOID'`,
      [saleId],
    );
    expect(voidLogs).toHaveLength(0);
    // Inventario devuelto por la NC FULL_VOID.
    const stock = await q<{ s: number }>(`SELECT stock::float AS s FROM products WHERE id = $1`, [
      productId,
    ]);
    expect(Number(stock[0].s)).toBeGreaterThan(0);
  });

  it('crédito SIN abonos: anular no mueve dinero', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await voidSale.execute(Number(saleId), cid, ACTOR, null, null);
    expect(await cashBalance()).toBe(CASH_START);
    expect(await bankBalance()).toBe(BANK_START);
  });

  it('con un abono por transferencia AÚN vivo, anular sin cuenta de devolución → 422 MISSING_REFUND_SOURCE', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await abonar(saleId, 'TRANSFER', 5000);

    await expect(voidSale.execute(Number(saleId), cid, ACTOR, null, null)).rejects.toMatchObject({
      response: { payload: { code: 'MISSING_REFUND_SOURCE' } },
    });
  });

  it('con un abono en efectivo vivo, anular devuelve ese efectivo de la caja (comportamiento de siempre)', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await abonar(saleId, 'CASH', 3000);

    await voidSale.execute(Number(saleId), cid, ACTOR, null, null);

    expect(await cashBalance()).toBe(CASH_START);
  });

  it('reversar un abono de una venta YA anulada → 422 SALE_VOIDED', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await abonar(saleId, 'CASH', 3000);
    const [pay] = await livePayments(saleId);
    await voidSale.execute(Number(saleId), cid, ACTOR, null, null);

    await expect(reverse(saleId, pay.id)).rejects.toMatchObject({
      response: { payload: { code: 'SALE_VOIDED' } },
    });
  });

  // ── Edición por banco: el saldo SÍ se mueve ───────────────────────────

  it('venta de contado editada con NC por BANCO: el saldo del banco baja (antes solo se registraba el movimiento)', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await q(`DELETE FROM sale_credits WHERE sale_invoice_id = $1`, [saleId]);
    // 2 × 4.150 = 8.300 → se reduce a 1 unidad: NC de 4.150 por cantidad.
    await q(
      `UPDATE sale_invoice_lines SET quantity = 2, unit_price = 4150 WHERE sale_invoice_id = $1`,
      [saleId],
    );
    await q(
      `INSERT INTO sale_payments (company_id, sale_invoice_id, payment_method, amount, change_amount, account_type, account_id, bank_id, is_voided, created_by_id)
       VALUES ($1,$2,'TRANSFER'::payment_method,8300,0,'bank',$3,$3,false,$4)`,
      [String(cid), saleId, bankId, String(ACTOR.id)],
    );

    await updateSale.execute(
      Number(saleId),
      {
        items: [
          {
            item_id: Number(productId),
            name: 'BOLSA MANIJA 1K UND',
            cost: 1000,
            price: 4150,
            quantity: 1,
            total: 4150,
          },
        ],
        total: 4150,
        cost: 1000,
        profit: 3300,
        margin: 76.74,
        credit_correction_source: { type: 'bank', id: bankId, name: 'BANCOLOMBIA' },
      } as unknown as UpdateSaleDto,
      cid,
      ACTOR,
    );

    // NC de 4.150 devuelta por el banco; nada entra a la caja.
    expect(await bankBalance()).toBe(BANK_START - 4150);
    expect(await cashBalance()).toBe(CASH_START);
  });

  it('venta de contado editada con ND por BANCO: el saldo del banco sube', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await q(`DELETE FROM sale_credits WHERE sale_invoice_id = $1`, [saleId]);

    await updateSale.execute(
      Number(saleId),
      {
        items: [
          {
            item_id: Number(productId),
            name: 'BOLSA MANIJA 1K UND',
            cost: 1000,
            price: 8300,
            quantity: 2,
            total: 16600,
          },
        ],
        total: 16600,
        cost: 2000,
        profit: 14600,
        margin: 87.95,
        debit_correction_source: { type: 'bank', id: bankId, name: 'BANCOLOMBIA' },
      } as unknown as UpdateSaleDto,
      cid,
      ACTOR,
    );

    expect(await bankBalance()).toBe(BANK_START + 8300);
  });

  it('NC por BANCO sin saldo suficiente → 422 y nada cambia', async () => {
    if (!ds) {
      return;
    }
    const saleId = await seedCredit();
    await q(`DELETE FROM sale_credits WHERE sale_invoice_id = $1`, [saleId]);
    await q(`UPDATE banks SET balance = 100 WHERE id = $1`, [bankId]);

    await expect(
      updateSale.execute(
        Number(saleId),
        {
          items: [
            {
              item_id: Number(productId),
              name: 'BOLSA MANIJA 1K UND',
              cost: 1000,
              price: 4300,
              quantity: 1,
              total: 4300,
            },
          ],
          total: 4300,
          cost: 1000,
          profit: 3300,
          margin: 76.74,
          credit_correction_source: { type: 'bank', id: bankId, name: 'BANCOLOMBIA' },
        } as unknown as UpdateSaleDto,
        cid,
        ACTOR,
      ),
    ).rejects.toMatchObject({ response: { payload: { code: 'INSUFFICIENT_BALANCE' } } });
    expect(await bankBalance()).toBe(100);
    const notes = await q(`SELECT id FROM credit_notes WHERE sale_invoice_id = $1`, [saleId]);
    expect(notes).toHaveLength(0);
  });
});
