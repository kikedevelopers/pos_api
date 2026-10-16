import Big from 'big.js';
import type { DataSource } from 'typeorm';

import type { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { GetConsolidatedInvoiceAction } from '@/modules/sales/actions/get-consolidated-invoice.action';
import { UpdateSaleAction, type UpdateSaleActor } from '@/modules/sales/actions/update-sale.action';
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
 * E2E (BD REAL pos_db) — REGRESIÓN DE PRODUCCIÓN VTA-1054 (PLASTICOS RICHARD).
 *
 * Un crédito del 15-oct se editó 3 veces el 16-oct y la factura terminó con
 * productos DUPLICADOS: J2 ECO PACA ×9 + ×2 cuando el cliente pidió 5, BOLSA
 * 15K ×6 + ×3, etc. Además cada ND registró un pago TRANSFER falso al banco
 * (2.532.300 en total) y descontó inventario de más.
 *
 * Aquí se reproduce la secuencia con la acción REAL (`UpdateSaleAction`) y el
 * carrito recargado desde el consolidado REAL (como hace el POS), y se fija:
 *   - Tras CADA edición, la factura consolidada == el carrito guardado.
 *   - Re-guardar sin cambios no emite notas.
 *   - El stock descontado == la cantidad final del carrito (ni una unidad más).
 *   - Siendo crédito, ninguna edición mueve dinero ni crea pagos; la deuda ==
 *     el total consolidado.
 */

const COMPANY = '__E2E_EDIT_NO_DUP_LINES__';
const ACTOR: UpdateSaleActor = { id: 0, fullName: 'Angie Bermudez', type: 'owner' };
const INITIAL_STOCK = 1000;

interface CartLine {
  item_id: number;
  name: string;
  cost: number;
  price: number;
  quantity: number;
  total: number;
}

describe('VTA-1054 — editar un crédito varias veces NO duplica productos (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let cid = 0;
  let customerId = '';
  let action: UpdateSaleAction;
  let consolidatedAction: GetConsolidatedInvoiceAction;
  const financialCalls: unknown[] = [];
  const ids: Record<string, number> = {};

  const PRODUCTS: Array<[string, string, number]> = [
    ['K1', 'BOLSA MANIJA 1K MILLAR (T15)', 12000],
    ['K5', 'BOLSA MANIJA 5K MILLAR (T25)', 30000],
    ['K3', 'BOLSA MANIJA 3K MILLAR', 26000],
    ['K10', 'BOLSA MANIJA 10K MILLAR', 45000],
    ['K15', 'BOLSA MANIJA 15K MILLAR', 50000],
    ['K20', 'BOLSA MANIJA 20K MILLAR', 70000],
    ['J2', 'J2 ECO PACA *200', 45000],
  ];
  const costOf = (code: string): number => PRODUCTS.find((p) => p[0] === code)![2];
  const nameOf = (code: string): string => PRODUCTS.find((p) => p[0] === code)![1];

  const cart = (code: string, price: number, quantity: number): CartLine => ({
    item_id: ids[code],
    name: nameOf(code),
    cost: costOf(code),
    price,
    quantity,
    total: new Big(price).times(quantity).toNumber(),
  });

  /** Payload que envía el POS (totales consolidados del carrito). */
  const dtoOf = (lines: CartLine[]): UpdateSaleDto => {
    const total = lines.reduce((s, l) => s.plus(l.total), new Big(0));
    const cost = lines.reduce((s, l) => s.plus(new Big(l.cost).times(l.quantity)), new Big(0));
    const profit = total.minus(cost);
    return {
      items: lines,
      total: total.toNumber(),
      cost: cost.toNumber(),
      profit: profit.toNumber(),
      margin: total.gt(0) ? Number(profit.div(total).times(100).toFixed(2)) : 0,
      // El POS viejo mandaba cuenta destino; siendo crédito debe ignorarse.
      debit_correction_source: { type: 'bank', id: 24, name: 'BANCOLOMBIA - RICHARD' },
      credit_correction_source: { type: 'cash_register', id: 0, name: 'Caja' },
    } as unknown as UpdateSaleDto;
  };

  /** Vista canónica producto|precio → cantidad. */
  const view = (lines: Array<{ item_id: number; price: number; quantity: number }>) => {
    const m = new Map<string, number>();
    for (const l of lines) {
      const k = `${Number(l.item_id)}|${new Big(l.price).toFixed(2)}`;
      m.set(k, new Big(m.get(k) ?? 0).plus(l.quantity).toNumber());
    }
    return Object.fromEntries([...m.entries()].sort());
  };

  async function reloadCart(saleId: string): Promise<CartLine[]> {
    const inv = await consolidatedAction.execute(Number(saleId), cid);
    return inv!.lines.map((l) => ({
      item_id: l.item_id,
      name: l.name,
      cost: l.cost,
      price: l.price,
      quantity: l.quantity,
      total: l.total,
    }));
  }

  async function stockOf(code: string): Promise<number> {
    const r: Array<{ s: number }> = await ds!.query(
      `SELECT stock::float AS s FROM products WHERE id = $1`,
      [ids[code]],
    );
    return Number(r[0].s);
  }

  async function assertInvoiceEqualsCart(saleId: string, expected: CartLine[]): Promise<void> {
    const inv = await consolidatedAction.execute(Number(saleId), cid);
    expect(view(inv!.lines)).toEqual(view(expected));
    const expectedTotal = expected.reduce((s, l) => s.plus(l.total), new Big(0)).toNumber();
    expect(inv!.total).toBe(expectedTotal);
    // Inventario: lo descontado == lo que quedó facturado (por producto).
    for (const [code] of PRODUCTS) {
      const billed = expected
        .filter((l) => l.item_id === ids[code])
        .reduce((s, l) => s.plus(l.quantity), new Big(0))
        .toNumber();
      expect(await stockOf(code)).toBe(INITIAL_STOCK - billed);
    }
    // Crédito: no entra ni sale dinero; la deuda == total consolidado.
    const pays: unknown[] = await ds!.query(
      `SELECT id FROM sale_payments WHERE sale_invoice_id = $1 AND is_voided = false`,
      [saleId],
    );
    expect(pays).toHaveLength(0);
    const logs: unknown[] = await ds!.query(
      `SELECT id FROM cash_register_logs WHERE invoice_id = $1`,
      [saleId],
    );
    expect(logs).toHaveLength(0);
    expect(financialCalls).toHaveLength(0);
    const credit: Array<{ total_amount: number; balance: number; status: string }> =
      await ds!.query(
        `SELECT total_amount::float AS total_amount, balance::float AS balance, status
           FROM sale_credits WHERE sale_invoice_id = $1`,
        [saleId],
      );
    expect(credit[0]).toEqual({
      total_amount: expectedTotal,
      balance: expectedTotal,
      status: 'PENDING',
    });
  }

  async function notesCount(saleId: string): Promise<number> {
    const r: Array<{ n: string }> = await ds!.query(
      `SELECT COUNT(*) AS n FROM credit_notes WHERE sale_invoice_id = $1`,
      [saleId],
    );
    return Number(r[0].n);
  }

  /** Factura original VTA-1054: crédito sin abonos por 1.526.700. */
  async function seedOriginal(): Promise<{ saleId: string; original: CartLine[] }> {
    const original = [
      cart('K1', 15700, 10),
      cart('K5', 36300, 8),
      cart('K3', 31500, 8),
      cart('K10', 58300, 5),
      cart('K15', 60200, 3),
      cart('K20', 81600, 2),
      cart('J2', 64000, 3),
    ];
    const total = original.reduce((s, l) => s + l.total, 0);
    expect(total).toBe(1526700);
    const r: Array<{ id: string }> = await ds!.query(
      `INSERT INTO sale_invoices
         (company_id, ticket_type, ticket_number, sale_number, subtotal, tax_total, total, cost,
          profit, margin, is_deleted, customer_id, customer_name, created_by_id)
       VALUES ($1,'SALE',$2,$6,$3,0,$3,0,0,0,false,$4,'SANTIAGO SERNA',$5) RETURNING id`,
      [
        String(cid),
        `PED-1069-${Date.now()}`,
        total,
        customerId,
        String(ACTOR.id),
        `VTA-1054-${Date.now()}`,
      ],
    );
    const saleId = r[0].id;
    for (const l of original) {
      await ds!.query(
        `INSERT INTO sale_invoice_lines
           (company_id, sale_invoice_id, product_id, description, quantity, unit_price, unit_cost, subtotal, total, packaging_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,1)`,
        [String(cid), saleId, l.item_id, l.name, l.quantity, l.price, l.cost, l.total],
      );
      // El cobro original ya descontó el stock de la venta.
      await ds!.query(`UPDATE products SET stock = stock - $2 WHERE id = $1`, [
        l.item_id,
        l.quantity,
      ]);
    }
    await ds!.query(
      `INSERT INTO sale_credits
         (company_id, sale_invoice_id, customer_id, total_amount, paid_amount, balance, status)
       VALUES ($1,$2,$3,$4,0,$4,'PENDING')`,
      [String(cid), saleId, customerId, total],
    );
    return { saleId, original };
  }

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — VTA-1054 e2e SKIPPED.');
      return;
    }
    cid = await createDisposableCompany(ds, COMPANY);
    ACTOR.id = await insertOwnerUser(ds, cid, 'vta1054');
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
        `INSERT INTO customers (company_id, name) VALUES ($1,'SANTIAGO SERNA') RETURNING id`,
        [String(cid)],
      )
    )[0].id;
    await ds.query(`INSERT INTO cash_registers (company_id, user_id, balance) VALUES ($1,$2,0)`, [
      String(cid),
      String(ACTOR.id),
    ]);
    const financialStub = {
      record: (_m: unknown, p: unknown) => {
        financialCalls.push(p);
        return Promise.resolve(undefined);
      },
    } as unknown as FinancialMovementsService;
    action = new UpdateSaleAction(ds, new IncrementTicketNumberAction(), financialStub);
    consolidatedAction = new GetConsolidatedInvoiceAction(ds);
  });

  beforeEach(async () => {
    if (!ds) {
      return;
    }
    // Productos frescos por test → el stock se puede afirmar en absoluto.
    for (const [code, name, cost] of PRODUCTS) {
      ids[code] = Number(
        await insertProduct(ds, cid, { name: `${name} ${Date.now()}`, cost, stock: INITIAL_STOCK }),
      );
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
      'customers',
      'ticket_settings',
    ]) {
      await ds.query(`DELETE FROM ${table} WHERE company_id = $1`, [c]);
    }
    await cleanupCompany(ds, cid);
    await ds.destroy();
  });

  it('reproduce las 3 ediciones de producción: la factura siempre == el carrito, sin duplicados ni dinero fantasma', async () => {
    if (!ds) {
      return;
    }
    const { saleId } = await seedOriginal();

    // EDICIÓN 1 (12:29) — sube cantidades y cambia precios de 4 líneas.
    const cart1 = [
      cart('K1', 16600, 20),
      cart('K5', 36300, 8),
      cart('K3', 31500, 8),
      cart('K10', 49900, 10),
      cart('K15', 61200, 6),
      cart('K20', 81600, 2),
      cart('J2', 49500, 5),
    ];
    await action.execute(Number(saleId), dtoOf(cart1), cid, ACTOR);
    await assertInvoiceEqualsCart(saleId, cart1);

    // EDICIÓN 2 (12:31) — recarga el carrito y vuelve a guardar sin cambios.
    const notesBefore = await notesCount(saleId);
    const cart2 = await reloadCart(saleId);
    await action.execute(Number(saleId), dtoOf(cart2), cid, ACTOR);
    expect(await notesCount(saleId)).toBe(notesBefore);
    await assertInvoiceEqualsCart(saleId, cart1);

    // EDICIÓN 3 (12:41) — la usuaria deja el J2 en 5 (ya estaba) y baja la 15K a 3.
    const cart3 = (await reloadCart(saleId)).map((l) =>
      l.item_id === ids.K15 ? cart('K15', l.price, 3) : l,
    );
    await action.execute(Number(saleId), dtoOf(cart3), cid, ACTOR);
    await assertInvoiceEqualsCart(saleId, cart3);

    // El cliente pidió 5 J2 → la factura dice 5 (no 9 + 2).
    const inv = await consolidatedAction.execute(Number(saleId), cid);
    const j2 = inv!.lines.filter((l) => l.item_id === ids.J2);
    expect(j2).toHaveLength(1);
    expect(j2[0].quantity).toBe(5);
  });

  it('venta que YA tiene un producto a dos precios (estado dañado de producción): re-guardar no factura de nuevo', async () => {
    if (!ds) {
      return;
    }
    const { saleId } = await seedOriginal();
    // Agrega 10 de la 1K a OTRO precio → la factura queda con dos líneas de 1K.
    const twoPrices = [...(await reloadCart(saleId)), cart('K1', 16600, 10)];
    await action.execute(Number(saleId), dtoOf(twoPrices), cid, ACTOR);
    await assertInvoiceEqualsCart(saleId, twoPrices);

    // Re-guardar 3 veces seguidas: nada cambia (antes cada guardado sumaba 10).
    for (let i = 0; i < 3; i += 1) {
      const reloaded = await reloadCart(saleId);
      await action.execute(Number(saleId), dtoOf(reloaded), cid, ACTOR);
      await assertInvoiceEqualsCart(saleId, twoPrices);
    }
    const inv = await consolidatedAction.execute(Number(saleId), cid);
    const k1 = inv!.lines.filter((l) => l.item_id === ids.K1).reduce((s, l) => s + l.quantity, 0);
    expect(k1).toBe(20);
  });

  it('replay del outbox (mismo payload y misma llave enviado 2 veces): la 2ª no emite notas', async () => {
    if (!ds) {
      return;
    }
    const { saleId } = await seedOriginal();
    const edited = [...(await reloadCart(saleId)), cart('J2', 49500, 2)];
    const payload = {
      ...dtoOf(edited),
      client_operation_id: '6f1c9a52-4c1e-4c8e-9d65-0b2a1f3e7d10',
    };

    await action.execute(Number(saleId), payload as UpdateSaleDto, cid, ACTOR);
    const notesAfterFirst = await notesCount(saleId);
    await action.execute(Number(saleId), payload as UpdateSaleDto, cid, ACTOR);

    expect(await notesCount(saleId)).toBe(notesAfterFirst);
    await assertInvoiceEqualsCart(saleId, edited);
  });

  it('ediciones concurrentes de la MISMA venta no duplican: el reintento SERIALIZABLE relee el consolidado', async () => {
    if (!ds) {
      return;
    }
    const { saleId } = await seedOriginal();
    const edited = [...(await reloadCart(saleId)), cart('K1', 16600, 10)];

    // Doble-click / dos pestañas: el mismo carrito enviado en paralelo.
    const results = await Promise.allSettled([
      action.execute(Number(saleId), dtoOf(edited), cid, ACTOR),
      action.execute(Number(saleId), dtoOf(edited), cid, ACTOR),
    ]);

    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    await assertInvoiceEqualsCart(saleId, edited);
  });

  it('borrar UNA de las dos líneas del mismo producto resta solo esa línea', async () => {
    if (!ds) {
      return;
    }
    const { saleId } = await seedOriginal();
    const twoPrices = [...(await reloadCart(saleId)), cart('J2', 49500, 2)];
    await action.execute(Number(saleId), dtoOf(twoPrices), cid, ACTOR);

    const withoutCheapJ2 = (await reloadCart(saleId)).filter(
      (l) => !(l.item_id === ids.J2 && l.price === 49500),
    );
    await action.execute(Number(saleId), dtoOf(withoutCheapJ2), cid, ACTOR);

    await assertInvoiceEqualsCart(saleId, withoutCheapJ2);
    const inv = await consolidatedAction.execute(Number(saleId), cid);
    expect(inv!.lines.filter((l) => l.item_id === ids.J2)).toEqual([
      expect.objectContaining({ price: 64000, quantity: 3 }),
    ]);
  });
});
