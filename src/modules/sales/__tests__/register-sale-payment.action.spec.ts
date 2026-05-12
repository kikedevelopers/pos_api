import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { RegisterSalePaymentAction } from '../actions/register-sale-payment.action';
import type { SaleCredit } from '../entities/sale-credit.entity';
import { SaleCreditStatus } from '../entities/sale-credit.entity';
import type { SaleInvoice } from '../entities/sale-invoice.entity';
import { TicketType } from '../entities/sale-invoice.entity';
import type { SalePayment } from '../entities/sale-payment.entity';
import { SalePaymentMethod } from '../entities/sale-payment.entity';

/**
 * Tests unitarios de `RegisterSalePaymentAction`. Cubrimos:
 *
 *   1. Idempotencia: uuid ya procesado → devuelve row existente sin tocar
 *      balances ni mover credit.
 *   2. Venta sin SaleCredit (ya pagada al contado) → 422.
 *   3. Monto > balance pendiente → 422.
 *   4. Banco de otra company → 404.
 *   5. Camino feliz: acredita banco, registra payment + financial movement,
 *      actualiza SaleCredit, incrementa Customer.balance.
 *   6. Pago que liquida → status PAID y balance 0.
 *   7. Toda dentro de UNA transacción.
 */
describe('RegisterSalePaymentAction', () => {
  let action: RegisterSalePaymentAction;
  let transactionSpy: jest.Mock;
  let recordSpy: jest.Mock;

  let creates: Array<{ entity: string; input: Record<string, unknown> }>;
  let saves: Array<{ entity: string; payload: Record<string, unknown> }>;
  let updates: Array<{
    entity: string;
    where: Record<string, unknown>;
    patch: Record<string, unknown>;
  }>;
  let increments: Array<{ entity: string; column: string; value: number }>;

  let sales: Map<string, Partial<SaleInvoice>>;
  let credits: Map<string, Partial<SaleCredit>>;
  let banks: Map<
    string,
    { id: string; company_id: string; name: string; balance: number; is_archived: boolean }
  >;
  let existingPayments: Map<string, Partial<SalePayment>>;

  beforeEach(async () => {
    creates = [];
    saves = [];
    updates = [];
    increments = [];

    sales = new Map();
    credits = new Map();
    banks = new Map();
    existingPayments = new Map();

    const managerMock = {
      findOne: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const where = options.where;

          if (entityName === 'SaleInvoice') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            const sale = sales.get(key);
            if (!sale) {
              return Promise.resolve(null);
            }
            if (where.is_deleted === false && sale.is_deleted) {
              return Promise.resolve(null);
            }
            return Promise.resolve(sale);
          }
          if (entityName === 'SaleCredit') {
            const purchaseKey = String(where.sale_invoice_id);
            return Promise.resolve(credits.get(purchaseKey) ?? null);
          }
          if (entityName === 'SalePayment') {
            // Idempotency lookup.
            const key = `${String(where.company_id)}|${String(where.uuid)}`;
            return Promise.resolve(existingPayments.get(key) ?? null);
          }
          if (entityName === 'Bank') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            const bank = banks.get(key);
            if (!bank || (where.is_archived === false && bank.is_archived)) {
              return Promise.resolve(null);
            }
            return Promise.resolve(bank);
          }
          return Promise.resolve(null);
        },
      ),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((entity: { name?: string } | string, input: Record<string, unknown>) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        creates.push({ entity: entityName, input });
        return input;
      }),
      save: jest.fn((entity: { name?: string } | string, payload: Record<string, unknown>) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        saves.push({ entity: entityName, payload });
        if (entityName === 'SalePayment') {
          return Promise.resolve({
            ...payload,
            id: '900',
            created_at: new Date('2026-05-12T14:30:00.000Z'),
          });
        }
        return Promise.resolve({ ...payload, id: '600' });
      }),
      update: jest.fn(
        (
          entity: { name?: string } | string,
          where: Record<string, unknown>,
          patch: Record<string, unknown>,
        ) => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          updates.push({ entity: entityName, where, patch });
          if (entityName === 'Bank') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            const bank = banks.get(key);
            if (bank && typeof patch.balance === 'number') {
              banks.set(key, { ...bank, balance: patch.balance });
            }
          }
          return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
        },
      ),
      increment: jest.fn(
        (
          entity: { name?: string } | string,
          _where: Record<string, unknown>,
          column: string,
          value: number,
        ) => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          increments.push({ entity: entityName, column, value });
          return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
        },
      ),
    };

    transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
      cb(managerMock),
    );
    recordSpy = jest.fn().mockResolvedValue(undefined);

    const dataSourceMock = { transaction: transactionSpy };
    const financialMovementsServiceMock = { record: recordSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegisterSalePaymentAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: FinancialMovementsService, useValue: financialMovementsServiceMock },
      ],
    }).compile();

    action = module.get(RegisterSalePaymentAction);
  });

  function seedSale(id: number, companyId: number, customerId = 1): void {
    sales.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      ticket_type: TicketType.SALE,
      ticket_number: '001',
      sale_number: '001',
      customer_id: String(customerId),
      customer_name: 'Customer 1',
      total: 1000,
      is_deleted: false,
    });
  }
  function seedCredit(
    saleId: number,
    opts: {
      total: number;
      paid: number;
      balance: number;
      status?: SaleCreditStatus;
      customerId?: number;
    },
  ): void {
    credits.set(String(saleId), {
      id: String(saleId * 10),
      sale_invoice_id: String(saleId),
      customer_id: String(opts.customerId ?? 1),
      total_amount: opts.total,
      paid_amount: opts.paid,
      balance: opts.balance,
      status: opts.status ?? SaleCreditStatus.PENDING,
    });
  }
  function seedBank(id: number, companyId: number, balance: number): void {
    banks.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      name: `Bank ${id}`,
      balance,
      is_archived: false,
    });
  }

  it('idempotency: uuid ya procesado devuelve payment existente sin reprocesar', async () => {
    seedSale(1, 42);
    seedCredit(1, { total: 1000, paid: 0, balance: 1000 });
    const uuid = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    existingPayments.set(`42|${uuid}`, {
      id: '999',
      company_id: '42',
      sale_invoice_id: '1',
      uuid,
      amount: 200,
      payment_method: SalePaymentMethod.TRANSFER,
    });

    const result = await action.execute(
      1,
      { account_type: 'bank', account_id: 1, amount: 200, uuid },
      42,
      { id: 7, fullName: 'O' },
    );

    expect(result.idempotent).toBe(true);
    expect(Number(result.payment.id)).toBe(999);
    expect(saves.find((s) => s.entity === 'SalePayment')).toBeUndefined();
    expect(updates.find((u) => u.entity === 'Bank')).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
    expect(updates.find((u) => u.entity === 'SaleCredit')).toBeUndefined();
  });

  it('rechaza venta sin SaleCredit (ya pagada al contado) con 422', async () => {
    seedSale(1, 42);
    // sin credit
    seedBank(1, 42, 5000);

    await expect(
      action.execute(1, { account_type: 'bank', account_id: 1, amount: 100 }, 42, {
        id: 7,
        fullName: 'O',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rechaza monto > balance pendiente con 422', async () => {
    seedSale(1, 42);
    seedCredit(1, { total: 1000, paid: 500, balance: 500 });
    seedBank(1, 42, 99999);

    await expect(
      action.execute(1, { account_type: 'bank', account_id: 1, amount: 700 }, 42, {
        id: 7,
        fullName: 'O',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rechaza banco de otra company con 404', async () => {
    seedSale(1, 42);
    seedCredit(1, { total: 1000, paid: 0, balance: 1000 });
    seedBank(1, 99, 99999); // company 99, no 42

    await expect(
      action.execute(1, { account_type: 'bank', account_id: 1, amount: 200 }, 42, {
        id: 7,
        fullName: 'O',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('camino feliz pago parcial: acredita banco, crea payment + FM, actualiza credit, incrementa Customer.balance', async () => {
    seedSale(1, 42, 5);
    seedCredit(1, { total: 1000, paid: 0, balance: 1000, customerId: 5 });
    seedBank(1, 42, 100);

    const result = await action.execute(
      1,
      { account_type: 'bank', account_id: 1, amount: 300 },
      42,
      { id: 7, fullName: 'Kike Pacheco' },
    );

    expect(result.idempotent).toBe(false);

    // 1. Bank balance: 100 + 300 = 400.
    const bankUpdate = updates.find((u) => u.entity === 'Bank');
    expect(bankUpdate?.patch.balance).toBe(400);

    // 2. SalePayment creado con payment_method TRANSFER, amount 300.
    const paymentCreate = creates.find((c) => c.entity === 'SalePayment');
    expect(paymentCreate?.input.amount).toBe(300);
    expect(paymentCreate?.input.payment_method).toBe(SalePaymentMethod.TRANSFER);
    expect(paymentCreate?.input.account_type).toBe('bank');
    expect(paymentCreate?.input.company_id).toBe('42');
    expect(paymentCreate?.input.created_by).toBe('Kike Pacheco');
    expect(paymentCreate?.input.uuid).toBeDefined();

    // 3. FinancialMovement (INCOME, SALE) con source external + destination bank.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const calls = recordSpy.mock.calls as Array<[unknown, Record<string, unknown>]>;
    const fmArgs = calls[0]?.[1];
    if (!fmArgs) {
      throw new Error('Expected record call');
    }
    expect(fmArgs.movement_type).toBe('INCOME');
    expect(fmArgs.concept).toBe('SALE');
    expect(fmArgs.source_type).toBe('external');
    expect(fmArgs.destination_type).toBe('bank');
    expect(fmArgs.amount).toBe(300);

    // 4. SaleCredit update: paid_amount=300, balance=700, status PARTIALLY_PAID.
    const creditUpdate = updates.find((u) => u.entity === 'SaleCredit');
    expect(creditUpdate?.patch.paid_amount).toBe(300);
    expect(creditUpdate?.patch.balance).toBe(700);
    expect(creditUpdate?.patch.status).toBe(SaleCreditStatus.PARTIALLY_PAID);

    // 5. Customer.balance += 300 (deuda del cliente se reduce; signed).
    const customerInc = increments.find((i) => i.entity === 'Customer');
    expect(customerInc?.column).toBe('balance');
    expect(customerInc?.value).toBe(300);
  });

  it('pago que liquida: status PAID y balance 0', async () => {
    seedSale(1, 42);
    seedCredit(1, { total: 1000, paid: 700, balance: 300 });
    seedBank(1, 42, 5000);

    await action.execute(1, { account_type: 'bank', account_id: 1, amount: 300 }, 42, {
      id: 7,
      fullName: 'O',
    });

    const creditUpdate = updates.find((u) => u.entity === 'SaleCredit');
    expect(creditUpdate?.patch.balance).toBe(0);
    expect(creditUpdate?.patch.paid_amount).toBe(1000);
    expect(creditUpdate?.patch.status).toBe(SaleCreditStatus.PAID);
  });

  it('Big.js: 0.1 + 0.2 sin error IEEE 754 en acreditación', async () => {
    seedSale(1, 42);
    seedCredit(1, { total: 1000, paid: 0, balance: 1000 });
    seedBank(1, 42, 0.2);

    await action.execute(1, { account_type: 'bank', account_id: 1, amount: 0.1 }, 42, {
      id: 7,
      fullName: 'O',
    });

    const bankUpdate = updates.find((u) => u.entity === 'Bank');
    // 0.2 + 0.1 = 0.3 sin IEEE 754.
    expect(bankUpdate?.patch.balance).toBe(0.3);
  });

  it('toda la operación ocurre dentro de UNA transacción', async () => {
    seedSale(1, 42);
    seedCredit(1, { total: 1000, paid: 0, balance: 1000 });
    seedBank(1, 42, 5000);

    await action.execute(1, { account_type: 'bank', account_id: 1, amount: 100 }, 42, {
      id: 7,
      fullName: 'O',
    });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });
});
