import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';

import { ProcessPaymentAction } from '../actions/process-payment.action';
import type { ProcessPaymentDto } from '../dto/process-payment.dto';
import { ProcessPaymentMethod } from '../dto/process-payment.dto';

// --------------------------------------------------------------------------
// Mocks de helpers internos. La action los importa como funciones módulo —
// los interceptamos para no tocar caja/inventario/margen reales y poder
// observar/forzar su comportamiento.
// --------------------------------------------------------------------------

jest.mock('@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper', () => ({
  getOrCreateCashRegisterForUser: jest.fn(),
}));
jest.mock('@/modules/sales/internal/margin-guard.helper', () => ({
  assertMarginAboveMinimum: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/modules/products/internal/adjust-inventory.helper', () => ({
  adjustInventory: jest.fn().mockResolvedValue(undefined),
}));

import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';

const getOrCreateMock = getOrCreateCashRegisterForUser as jest.MockedFunction<
  typeof getOrCreateCashRegisterForUser
>;

/**
 * Tests del refactor a PAGO DIVIDIDO (split tender) de `ProcessPaymentAction`.
 * Cubrimos:
 *
 *   1. Split de 2 métodos exacto (CASH + TRANSFER) que cuadra `amount_due`.
 *   2. Split + crédito por el remanente.
 *   3. Validación de cuadre (no suma `amount_due` → PAYMENT_BREAKDOWN_MISMATCH).
 *   4. TRANSFER sin bank → TRANSFER_REQUIRES_BANK.
 *   5. Idempotencia: replay del mismo `client_operation_id` no reprocesa.
 *   6. Retrocompat shape plano legado.
 */
describe('ProcessPaymentAction (split tender)', () => {
  let action: ProcessPaymentAction;

  // Estado observable del manager mock.
  let saves: Array<{ entity: string; payload: Record<string, unknown> }>;
  let updates: Array<{
    entity: string;
    where: Record<string, unknown>;
    patch: Record<string, unknown>;
  }>;
  let recordSpy: jest.Mock;
  let banks: Map<
    string,
    { id: string; company_id: string; name: string; balance: number; is_archived: boolean }
  >;
  let cashRegisterBalance: number;
  let savedPaymentSeq: number;
  // ADVANCE: saldo a favor del cliente y su id en la factura (configurables por
  // test para cubrir suficiente / insuficiente / sin cliente).
  let customerAdvanceBalance: number;
  let saleCustomerId: string | null;

  // Estado del repo (fuera de TX) para el fast-path idempotente.
  let existingPaymentsByUuid: Map<string, { id: string; sale_invoice_id: string }>;
  let paymentsByInvoice: Map<string, Array<{ id: string }>>;

  function buildManagerMock() {
    const mgr = {
      findOne: jest.fn(
        (entity: { name?: string } | string, options: { where: Record<string, unknown> }) => {
          const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const where = options.where;
          if (name === 'SaleInvoice') {
            return Promise.resolve({
              id: '142',
              company_id: String(where.company_id),
              customer_id: saleCustomerId,
              ticket_type: 'ORDER',
              total: 150,
              cost: 80,
              is_deleted: false,
            });
          }
          if (name === 'Bank') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            return Promise.resolve(banks.get(key) ?? null);
          }
          if (name === 'Customer') {
            // consumeCustomerAdvance bloquea el cliente y lee advance_balance.
            return Promise.resolve({
              id: String(where.id),
              company_id: String(where.company_id),
              advance_balance: customerAdvanceBalance,
            });
          }
          return Promise.resolve(null);
        },
      ),
      find: jest.fn().mockResolvedValue([]), // sin líneas → no toca inventario
      // HISTORIAL DE ESTADOS: `recordSaleStatus` inserta un evento
      // (COLLECTED / CREDIT_OPENED) vía `manager.insert`. No afecta el resto de
      // aserciones; solo debe existir como no-op resoluble.
      insert: jest.fn().mockResolvedValue({ raw: [], identifiers: [], generatedMaps: [] }),
      create: jest.fn((_entity: unknown, input: Record<string, unknown>) => input),
      save: jest.fn((entity: { name?: string } | string, payload: Record<string, unknown>) => {
        const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        saves.push({ entity: name, payload });
        savedPaymentSeq += 1;
        return Promise.resolve({ ...payload, id: String(savedPaymentSeq) });
      }),
      update: jest.fn(
        (
          entity: { name?: string } | string,
          where: Record<string, unknown>,
          patch: Record<string, unknown>,
        ) => {
          const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          updates.push({ entity: name, where, patch });
          if (name === 'Bank') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            const bank = banks.get(key);
            if (bank && typeof patch.balance === 'number') {
              banks.set(key, { ...bank, balance: patch.balance });
            }
          }
          return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
        },
      ),
      // `recomputeSalePoints` (puntos de cliente) usa el repo del manager de la
      // TX: `manager.getRepository(SaleInvoice)`. Delegamos en los mismos mocks
      // para que la venta ORDER del split-tender haga bail-out (no es SALE aún)
      // sin romper. Añadido cuando el recompute entró al flujo de pago.
      getRepository: jest.fn((entity: { name?: string } | string) => {
        const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        return {
          findOne: (options: { where: Record<string, unknown> }) => mgr.findOne(name, options),
          find: (options: { where: Record<string, unknown> }) => mgr.find(name, options),
          update: (where: Record<string, unknown>, patch: Record<string, unknown>) =>
            mgr.update(name, where, patch),
          save: (payload: Record<string, unknown>) => mgr.save(name, payload),
        };
      }),
    };
    return mgr;
  }

  beforeEach(async () => {
    saves = [];
    updates = [];
    banks = new Map();
    cashRegisterBalance = 1000;
    savedPaymentSeq = 100;
    customerAdvanceBalance = 500;
    saleCustomerId = '55';
    existingPaymentsByUuid = new Map();
    paymentsByInvoice = new Map();

    getOrCreateMock.mockReset();
    getOrCreateMock.mockImplementation(() =>
      Promise.resolve({
        id: '9',
        company_id: '42',
        balance: cashRegisterBalance,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );

    recordSpy = jest.fn().mockResolvedValue(undefined);

    // DataSource mock: transaction(isolation, cb) + getRepository(...) para replay.
    const transaction = jest.fn(
      async <T>(_isolation: unknown, cb: (m: ReturnType<typeof buildManagerMock>) => Promise<T>) =>
        cb(buildManagerMock()),
    );
    const getRepository = jest.fn((entity: { name?: string }) => {
      const name = entity.name ?? 'Unknown';
      if (name === 'SalePayment') {
        return {
          findOne: jest.fn((opts: { where: { uuid?: string } }) =>
            Promise.resolve(
              opts.where.uuid ? (existingPaymentsByUuid.get(opts.where.uuid) ?? null) : null,
            ),
          ),
          find: jest.fn((opts: { where: { sale_invoice_id?: string } }) =>
            Promise.resolve(paymentsByInvoice.get(String(opts.where.sale_invoice_id)) ?? []),
          ),
        };
      }
      if (name === 'SaleCredit') {
        return { findOne: jest.fn().mockResolvedValue(null) };
      }
      if (name === 'SaleInvoice') {
        return { findOne: jest.fn().mockResolvedValue({ id: '142', sale_number: 'SALE-001' }) };
      }
      return { findOne: jest.fn().mockResolvedValue(null), find: jest.fn().mockResolvedValue([]) };
    });
    const dataSourceMock = { transaction, getRepository };

    const incrementMock = {
      execute: jest.fn().mockResolvedValue({ number: 1, formatted: 'SALE-001' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProcessPaymentAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: IncrementTicketNumberAction, useValue: incrementMock },
        { provide: FinancialMovementsService, useValue: { record: recordSpy } },
      ],
    }).compile();

    action = module.get(ProcessPaymentAction);
  });

  const actor = { id: 7, fullName: 'Kike Pacheco', type: 'owner' };

  function seedBank(id: number, balance: number) {
    banks.set(`${id}|42`, {
      id: String(id),
      company_id: '42',
      name: `Bank ${id}`,
      balance,
      is_archived: false,
    });
  }

  it('split exacto: CASH 100 + TRANSFER 50 = 150 → 2 SalePayment, banco +50, caja +100', async () => {
    seedBank(7, 2000);
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [
        { payment_method: ProcessPaymentMethod.CASH, amount_paid: 100, change_amount: 0 },
        {
          payment_method: ProcessPaymentMethod.TRANSFER,
          amount_paid: 50,
          bank_id: 7,
          bank_name: 'Bank 7',
        },
      ],
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, null);

    expect(result.success).toBe(true);
    const paymentSaves = saves.filter((s) => s.entity === 'SalePayment');
    expect(paymentSaves).toHaveLength(2);
    expect(result.payment_ids).toHaveLength(2);
    expect(result.payment_id).toBe(result.payment_ids?.[0]);

    // Caja sube por el neto del tender CASH (100), no por amount_due (150).
    const cashUpdate = updates.find((u) => u.entity === 'CashRegister');
    expect(cashUpdate?.patch.balance).toBe(1100); // 1000 + 100

    // Banco sube por el monto del tender TRANSFER (50).
    const bankUpdate = updates.find((u) => u.entity === 'Bank');
    expect(bankUpdate?.patch.balance).toBe(2050); // 2000 + 50

    // FinancialMovement por el monto del tender (50), no por el total.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect((recordSpy.mock.calls[0] as [unknown, { amount: number }])[1].amount).toBe(50);
  });

  it('split + crédito remanente: CASH 100 + crédito 50 = 150 → 1 SalePayment + SaleCredit', async () => {
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [{ payment_method: ProcessPaymentMethod.CASH, amount_paid: 100, change_amount: 0 }],
      is_credit: true,
      credit_amount: 50,
    };

    const result = await action.execute(dto, 42, actor, null);

    expect(result.success).toBe(true);
    expect(saves.filter((s) => s.entity === 'SalePayment')).toHaveLength(1);
    const creditSave = saves.find((s) => s.entity === 'SaleCredit');
    expect(creditSave).toBeDefined();
    expect(creditSave?.payload.balance).toBe(50);
    expect(creditSave?.payload.total_amount).toBe(50);
    expect(result.credit_id).not.toBeNull();
  });

  it('crédito puro: payments vacío + crédito 150 = 150 → 0 SalePayment + SaleCredit', async () => {
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [],
      is_credit: true,
      credit_amount: 150,
    };

    const result = await action.execute(dto, 42, actor, null);

    expect(result.success).toBe(true);
    expect(saves.filter((s) => s.entity === 'SalePayment')).toHaveLength(0);
    const creditSave = saves.find((s) => s.entity === 'SaleCredit');
    expect(creditSave).toBeDefined();
    expect(creditSave?.payload.balance).toBe(150);
    expect(creditSave?.payload.total_amount).toBe(150);
    expect(result.payment_id).toBeNull();
    expect(result.credit_id).not.toBeNull();
  });

  it('cuadre inválido: CASH 100 + crédito 30 ≠ 150 → PAYMENT_BREAKDOWN_MISMATCH', async () => {
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [{ payment_method: ProcessPaymentMethod.CASH, amount_paid: 100, change_amount: 0 }],
      is_credit: true,
      credit_amount: 30,
    };

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(false);
    expect(result.code).toBe('PAYMENT_BREAKDOWN_MISMATCH');
    expect(saves.filter((s) => s.entity === 'SalePayment')).toHaveLength(0);
  });

  it('cash con sobrepago neteado: amount_paid 200, change 50, neto 150 cuadra', async () => {
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [
        { payment_method: ProcessPaymentMethod.CASH, amount_paid: 200, change_amount: 50 },
      ],
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(true);
    // Caja sube por el neto (200 - 50 = 150).
    const cashUpdate = updates.find((u) => u.entity === 'CashRegister');
    expect(cashUpdate?.patch.balance).toBe(1150);
  });

  it('TRANSFER con change>0 → INVALID_CHANGE_AMOUNT (en transferencia no hay vuelto)', async () => {
    seedBank(7, 1000);
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [
        {
          payment_method: ProcessPaymentMethod.TRANSFER,
          amount_paid: 160,
          change_amount: 10,
          bank_id: 7,
        },
      ],
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_CHANGE_AMOUNT');
    // Banco intacto, ningún pago creado.
    expect(updates.find((u) => u.entity === 'Bank')).toBeUndefined();
    expect(saves.filter((s) => s.entity === 'SalePayment')).toHaveLength(0);
  });

  it('neto negativo: change > amount_paid → INVALID_CHANGE_AMOUNT (no resta de caja)', async () => {
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [
        { payment_method: ProcessPaymentMethod.CASH, amount_paid: 100, change_amount: 120 },
        { payment_method: ProcessPaymentMethod.CASH, amount_paid: 170, change_amount: 0 },
      ],
      // Σ neto = (100-120) + 170 = 150 → cuadraría el invariante, pero el
      // primer tender tiene neto negativo y debe rechazarse ANTES.
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_CHANGE_AMOUNT');
    expect(updates.find((u) => u.entity === 'CashRegister')).toBeUndefined();
  });

  it('TRANSFER acredita el banco por el NETO (= amount_paid, change forzado a 0)', async () => {
    seedBank(7, 1000);
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [
        {
          payment_method: ProcessPaymentMethod.TRANSFER,
          amount_paid: 150,
          bank_id: 7,
          bank_name: 'Bank 7',
        },
      ],
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(true);
    const bankUpdate = updates.find((u) => u.entity === 'Bank');
    expect(bankUpdate?.patch.balance).toBe(1150); // 1000 + 150 neto
    // SalePayment TRANSFER persiste change_amount = 0 por contrato.
    const transferSave = saves.find(
      (s) => s.entity === 'SalePayment' && s.payload.payment_method === 'TRANSFER',
    );
    expect(transferSave?.payload.change_amount).toBe(0);
    // FinancialMovement por el neto.
    expect((recordSpy.mock.calls[0] as [unknown, { amount: number }])[1].amount).toBe(150);
  });

  it('TRANSFER sin bank_id → TRANSFER_REQUIRES_BANK', async () => {
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [{ payment_method: ProcessPaymentMethod.TRANSFER, amount_paid: 150 }],
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(false);
    expect(result.code).toBe('TRANSFER_REQUIRES_BANK');
  });

  it('idempotencia: replay del mismo client_operation_id devuelve el resultado previo sin reprocesar', async () => {
    const uuid = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    // El tender 0 usó la llave pura → ese row existe.
    existingPaymentsByUuid.set(uuid, { id: '500', sale_invoice_id: '142' });
    paymentsByInvoice.set('142', [{ id: '500' }, { id: '501' }]);

    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [
        { payment_method: ProcessPaymentMethod.CASH, amount_paid: 100 },
        { payment_method: ProcessPaymentMethod.TRANSFER, amount_paid: 50, bank_id: 7 },
      ],
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, uuid);
    expect(result.replay).toBe(true);
    expect(result.payment_id).toBe(500);
    expect(result.payment_ids).toEqual([500, 501]);
    // No se insertó ningún pago nuevo.
    expect(saves.filter((s) => s.entity === 'SalePayment')).toHaveLength(0);
  });

  it('uuid por pago: tender 0 lleva la llave pura, tender 1 lleva `${key}:1`', async () => {
    seedBank(7, 1000);
    const uuid = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [
        { payment_method: ProcessPaymentMethod.CASH, amount_paid: 100 },
        { payment_method: ProcessPaymentMethod.TRANSFER, amount_paid: 50, bank_id: 7 },
      ],
      is_credit: false,
      credit_amount: 0,
    };

    await action.execute(dto, 42, actor, uuid);
    const paymentSaves = saves.filter((s) => s.entity === 'SalePayment');
    expect(paymentSaves[0].payload.uuid).toBe(uuid);
    expect(paymentSaves[1].payload.uuid).toBe(`${uuid}:1`);
  });

  it('retrocompat shape plano: payment_method/amount_paid en raíz se normaliza a un tender', async () => {
    const dto = {
      invoice_id: 142,
      amount_due: 150,
      payment_method: ProcessPaymentMethod.CASH,
      amount_paid: 150,
      change_amount: 0,
      is_credit: false,
      credit_amount: 0,
    } as unknown as ProcessPaymentDto;

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(true);
    expect(saves.filter((s) => s.entity === 'SalePayment')).toHaveLength(1);
    const cashUpdate = updates.find((u) => u.entity === 'CashRegister');
    expect(cashUpdate?.patch.balance).toBe(1150); // 1000 + 150
  });

  it('payments vacío y sin shape plano → INVALID_PAYMENT_ITEM', async () => {
    const dto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [],
      is_credit: false,
      credit_amount: 0,
    } as unknown as ProcessPaymentDto;

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_PAYMENT_ITEM');
  });

  // --------------------------------------------------------------------------
  // ADVANCE (anticipo del cliente como medio de pago)
  // --------------------------------------------------------------------------

  it('cobro total con ADVANCE: descuenta advance_balance, NO mueve caja/banco, SalePayment customer_advance', async () => {
    customerAdvanceBalance = 500; // suficiente para 150
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [{ payment_method: ProcessPaymentMethod.ADVANCE, amount_paid: 150, change_amount: 0 }],
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(true);

    // 1 SalePayment con account_type customer_advance, account_id = customer_id.
    const paymentSaves = saves.filter((s) => s.entity === 'SalePayment');
    expect(paymentSaves).toHaveLength(1);
    expect(paymentSaves[0].payload.payment_method).toBe('ADVANCE');
    expect(paymentSaves[0].payload.account_type).toBe('customer_advance');
    expect(paymentSaves[0].payload.account_id).toBe('55');
    expect(paymentSaves[0].payload.bank_id).toBeNull();
    expect(paymentSaves[0].payload.change_amount).toBe(0);
    expect(paymentSaves[0].payload.amount).toBe(150);

    // advance_balance descontado: 500 - 150 = 350.
    const advanceUpdate = updates.find(
      (u) => u.entity === 'Customer' && u.patch.advance_balance !== undefined,
    );
    expect(advanceUpdate?.patch.advance_balance).toBe(350);

    // NO mueve caja/banco ni emite FinancialMovement/CashRegisterLog.
    expect(updates.find((u) => u.entity === 'CashRegister')).toBeUndefined();
    expect(updates.find((u) => u.entity === 'Bank')).toBeUndefined();
    expect(saves.find((s) => s.entity === 'CashRegisterLog')).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('ADVANCE insuficiente → 422 ADVANCE_EXCEEDS_BALANCE, ningún pago creado', async () => {
    customerAdvanceBalance = 100; // < 150 requerido
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [{ payment_method: ProcessPaymentMethod.ADVANCE, amount_paid: 150, change_amount: 0 }],
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(false);
    expect(result.code).toBe('ADVANCE_EXCEEDS_BALANCE');
    expect(saves.filter((s) => s.entity === 'SalePayment')).toHaveLength(0);
  });

  it('ADVANCE sin cliente en la factura → ADVANCE_REQUIRES_CUSTOMER', async () => {
    saleCustomerId = null;
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [{ payment_method: ProcessPaymentMethod.ADVANCE, amount_paid: 150, change_amount: 0 }],
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(false);
    expect(result.code).toBe('ADVANCE_REQUIRES_CUSTOMER');
    expect(saves.filter((s) => s.entity === 'SalePayment')).toHaveLength(0);
    // No se descontó advance_balance.
    expect(
      updates.find((u) => u.entity === 'Customer' && u.patch.advance_balance !== undefined),
    ).toBeUndefined();
  });

  it('ADVANCE con banco → INVALID_PAYMENT_ITEM (el anticipo no lleva banco)', async () => {
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [
        { payment_method: ProcessPaymentMethod.ADVANCE, amount_paid: 150, bank_id: 7 },
      ],
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_PAYMENT_ITEM');
  });

  it('combinación ADVANCE 100 + CASH 50 = 150: descuenta 100 del anticipo, caja +50', async () => {
    customerAdvanceBalance = 300;
    const dto: ProcessPaymentDto = {
      invoice_id: 142,
      amount_due: 150,
      payments: [
        { payment_method: ProcessPaymentMethod.ADVANCE, amount_paid: 100, change_amount: 0 },
        { payment_method: ProcessPaymentMethod.CASH, amount_paid: 50, change_amount: 0 },
      ],
      is_credit: false,
      credit_amount: 0,
    };

    const result = await action.execute(dto, 42, actor, null);
    expect(result.success).toBe(true);

    // 2 SalePayment: uno ADVANCE (customer_advance) y uno CASH (cash_register).
    const paymentSaves = saves.filter((s) => s.entity === 'SalePayment');
    expect(paymentSaves).toHaveLength(2);
    expect(paymentSaves.some((p) => p.payload.account_type === 'customer_advance')).toBe(true);
    expect(paymentSaves.some((p) => p.payload.account_type === 'cash_register')).toBe(true);

    // advance_balance: 300 - 100 = 200.
    const advanceUpdate = updates.find(
      (u) => u.entity === 'Customer' && u.patch.advance_balance !== undefined,
    );
    expect(advanceUpdate?.patch.advance_balance).toBe(200);

    // Caja sube solo por el tender CASH (50).
    const cashUpdate = updates.find((u) => u.entity === 'CashRegister');
    expect(cashUpdate?.patch.balance).toBe(1050); // 1000 + 50
  });
});
