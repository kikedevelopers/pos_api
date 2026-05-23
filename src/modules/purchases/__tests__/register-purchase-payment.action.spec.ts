import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { RegisterPurchasePaymentAction } from '../actions/register-purchase-payment.action';
import type { PurchaseCredit } from '../entities/purchase-credit.entity';
import { PurchaseCreditStatus } from '../entities/purchase-credit.entity';
import type { PurchasePayment } from '../entities/purchase-payment.entity';
import { PurchasePaymentMethod } from '../entities/purchase-payment.entity';
import type { Purchase } from '../entities/purchase.entity';
import { PurchaseStatus } from '../entities/purchase.entity';

/**
 * Tests unitarios de `RegisterPurchasePaymentAction`. Cubrimos:
 *
 *   1. Idempotencia: uuid ya procesado → devuelve row existente con
 *      `idempotent = true` SIN tocar balances.
 *   2. Saldo de bank insuficiente → 422.
 *   3. Monto > balance pendiente del credit → 422.
 *   4. Camino feliz: PurchasePayment + FinancialMovement + actualización
 *      del PurchaseCredit + decremento de bank balance + decremento de
 *      supplier debt.
 *   5. Pago que liquida → status PAID.
 */
describe('RegisterPurchasePaymentAction', () => {
  let action: RegisterPurchasePaymentAction;
  let transactionSpy: jest.Mock;
  let recordSpy: jest.Mock;
  let updates: Array<{
    entity: string;
    where: Record<string, unknown>;
    patch: Record<string, unknown>;
  }>;
  let decrements: Array<{ entity: string; column: string; value: number }>;
  let creates: Array<{ entity: string; input: Record<string, unknown> }>;
  let saves: Array<{ entity: string; payload: Record<string, unknown> }>;
  let purchases: Map<string, Partial<Purchase>>;
  let credits: Map<string, Partial<PurchaseCredit>>;
  let banks: Map<
    string,
    { id: string; company_id: string; name: string; balance: number; is_archived: boolean }
  >;
  let existingPayments: Map<string, Partial<PurchasePayment>>;

  beforeEach(async () => {
    transactionSpy = jest.fn();
    recordSpy = jest.fn().mockResolvedValue(undefined);
    updates = [];
    decrements = [];
    creates = [];
    saves = [];
    purchases = new Map();
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
          if (entityName === 'PurchasePayment') {
            const key = `${String(where.company_id)}|${String(where.uuid)}`;
            return Promise.resolve(existingPayments.get(key) ?? null);
          }
          if (entityName === 'Purchase') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            return Promise.resolve(purchases.get(key) ?? null);
          }
          if (entityName === 'PurchaseCredit') {
            const purchaseKey = String(where.purchase_id ?? where.id);
            return Promise.resolve(credits.get(purchaseKey) ?? null);
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
        if (entityName === 'PurchasePayment') {
          return Promise.resolve({
            ...payload,
            id: '500',
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
      decrement: jest.fn(
        (
          entity: { name?: string } | string,
          _where: Record<string, unknown>,
          column: string,
          value: number,
        ) => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          decrements.push({ entity: entityName, column, value });
          return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
        },
      ),
      // Mock QueryBuilder para dos usos:
      //   1. `nextPaymentNumber` → select + where + orderBy + limit + getRawOne.
      //   2. lock + lectura de `PurchaseCredit` → setLock + where + getOne.
      // El mock retorna un chain neutral que soporta ambas APIs; getOne resuelve
      // a partir del Map `credits` cuando el entity es PurchaseCredit.
      createQueryBuilder: jest.fn((entity?: { name?: string } | string) => {
        const entityName = typeof entity === 'string' ? entity : (entity?.name ?? 'Unknown');
        let whereParams: Record<string, unknown> = {};
        const chain: Record<string, jest.Mock> = {
          select: jest.fn().mockReturnThis(),
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn((_clause: string, params?: Record<string, unknown>) => {
            if (params) {
              whereParams = { ...whereParams, ...params };
            }
            return chain;
          }),
          andWhere: jest.fn((_clause: string, params?: Record<string, unknown>) => {
            if (params) {
              whereParams = { ...whereParams, ...params };
            }
            return chain;
          }),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue(null),
          getOne: jest.fn(() => {
            if (entityName === 'PurchaseCredit') {
              const purchaseId = String(whereParams.id ?? whereParams.purchase_id ?? '');
              return Promise.resolve(credits.get(purchaseId) ?? null);
            }
            return Promise.resolve(null);
          }),
        };
        return chain;
      }),
      query: jest.fn().mockResolvedValue([]),
    };

    transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
      cb(managerMock),
    );
    const dataSourceMock = { transaction: transactionSpy };
    const financialMovementsServiceMock = { record: recordSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegisterPurchasePaymentAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: FinancialMovementsService, useValue: financialMovementsServiceMock },
      ],
    }).compile();

    action = module.get(RegisterPurchasePaymentAction);
  });

  function seedPurchase(id: number, companyId: number, supplierId = 1): void {
    purchases.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      purchase_number: 'PUR-001',
      supplier_id: String(supplierId),
      supplier_name: 'Supplier A',
      total: 1000,
      is_deleted: false,
      status: PurchaseStatus.PENDING,
    });
  }
  function seedCredit(
    purchaseId: number,
    opts: { total: number; paid: number; balance: number; status?: PurchaseCreditStatus },
  ): void {
    credits.set(String(purchaseId), {
      id: String(purchaseId * 10),
      purchase_id: String(purchaseId),
      total_amount: opts.total,
      paid_amount: opts.paid,
      balance: opts.balance,
      status: opts.status ?? PurchaseCreditStatus.PENDING,
    });
  }
  function seedBank(id: number, companyId: number, balance: number, name = `Bank ${id}`): void {
    banks.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      name,
      balance,
      is_archived: false,
    });
  }

  it('idempotencia: si llega uuid ya procesado, devuelve el row existente sin reprocesar', async () => {
    seedPurchase(1, 42);
    const uuid = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    existingPayments.set(`42|${uuid}`, {
      id: '999',
      company_id: '42',
      purchase_id: '1',
      uuid,
      amount: 200,
      payment_number: 'ABO-007',
      payment_method: PurchasePaymentMethod.TRANSFER,
    });

    const result = await action.execute(
      1,
      { source_type: 'bank', source_id: 1, amount: 200, uuid },
      42,
      { id: 7, fullName: 'Owner' },
    );

    expect(result.idempotent).toBe(true);
    expect(Number(result.payment.id)).toBe(999);
    // No se debe haber creado ningún payment nuevo ni movido balances.
    expect(saves.find((s) => s.entity === 'PurchasePayment')).toBeUndefined();
    expect(updates.find((u) => u.entity === 'Bank')).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('rechaza monto > balance pendiente con 422', async () => {
    seedPurchase(1, 42);
    seedCredit(1, { total: 1000, paid: 500, balance: 500 });
    seedBank(1, 42, 99999);

    await expect(
      action.execute(1, { source_type: 'bank', source_id: 1, amount: 700 }, 42, {
        id: 7,
        fullName: 'O',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rechaza saldo bancario insuficiente con 422', async () => {
    seedPurchase(1, 42);
    seedCredit(1, { total: 1000, paid: 0, balance: 1000 });
    seedBank(1, 42, 50); // tiene menos que 200

    await expect(
      action.execute(1, { source_type: 'bank', source_id: 1, amount: 200 }, 42, {
        id: 7,
        fullName: 'O',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rechaza banco de otra company con 404', async () => {
    seedPurchase(1, 42);
    seedCredit(1, { total: 1000, paid: 0, balance: 1000 });
    // bank id=1 existe en company 99, NO en 42.
    seedBank(1, 99, 99999);

    await expect(
      action.execute(1, { source_type: 'bank', source_id: 1, amount: 200 }, 42, {
        id: 7,
        fullName: 'O',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('camino feliz pago parcial: debita banco, registra payment + financial movement, actualiza credit', async () => {
    seedPurchase(1, 42);
    seedCredit(1, { total: 1000, paid: 0, balance: 1000 });
    seedBank(1, 42, 5000);

    const result = await action.execute(1, { source_type: 'bank', source_id: 1, amount: 300 }, 42, {
      id: 7,
      fullName: 'Kike Pacheco',
    });

    expect(result.idempotent).toBe(false);

    // 1. Bank balance: 5000 - 300 = 4700.
    const bankUpdate = updates.find((u) => u.entity === 'Bank');
    expect(bankUpdate?.patch.balance).toBe(4700);

    // 2. PurchasePayment creado con payment_method TRANSFER, amount 300.
    const paymentCreate = creates.find((c) => c.entity === 'PurchasePayment');
    expect(paymentCreate?.input.amount).toBe(300);
    expect(paymentCreate?.input.payment_method).toBe(PurchasePaymentMethod.TRANSFER);
    expect(paymentCreate?.input.payment_number).toBe('ABO-001');
    expect(paymentCreate?.input.company_id).toBe('42');
    expect(paymentCreate?.input.created_by).toBe('Kike Pacheco');
    expect(paymentCreate?.input.uuid).toBeDefined();

    // 3. FinancialMovement (EXPENSE, PURCHASE).
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const calls = recordSpy.mock.calls as Array<[unknown, Record<string, unknown>]>;
    const fmArgs = calls[0]?.[1];
    if (!fmArgs) {
      throw new Error('Expected record call');
    }
    expect(fmArgs.movement_type).toBe('EXPENSE');
    expect(fmArgs.concept).toBe('PURCHASE');
    expect(fmArgs.source_type).toBe('bank');
    expect(fmArgs.destination_type).toBe('external');
    expect(fmArgs.amount).toBe(300);

    // 4. PurchaseCredit update: paid_amount = 300, balance = 700, status PARTIALLY_PAID.
    const creditUpdate = updates.find((u) => u.entity === 'PurchaseCredit');
    expect(creditUpdate?.patch.paid_amount).toBe(300);
    expect(creditUpdate?.patch.balance).toBe(700);
    expect(creditUpdate?.patch.status).toBe(PurchaseCreditStatus.PARTIALLY_PAID);

    // 5. Supplier.accumulated_debt -= 300.
    const supplierDec = decrements.find((d) => d.entity === 'Supplier');
    expect(supplierDec?.column).toBe('accumulated_debt');
    expect(supplierDec?.value).toBe(300);
  });

  it('pago que liquida: status PAID y balance 0', async () => {
    seedPurchase(1, 42);
    seedCredit(1, { total: 1000, paid: 700, balance: 300 });
    seedBank(1, 42, 5000);

    await action.execute(1, { source_type: 'bank', source_id: 1, amount: 300 }, 42, {
      id: 7,
      fullName: 'O',
    });

    const creditUpdate = updates.find((u) => u.entity === 'PurchaseCredit');
    expect(creditUpdate?.patch.balance).toBe(0);
    expect(creditUpdate?.patch.paid_amount).toBe(1000);
    expect(creditUpdate?.patch.status).toBe(PurchaseCreditStatus.PAID);
  });

  it('Big.js: 0.1 + 0.2 limpio en debitos', async () => {
    seedPurchase(1, 42);
    seedCredit(1, { total: 1000, paid: 0, balance: 1000 });
    seedBank(1, 42, 0.3);

    await action.execute(1, { source_type: 'bank', source_id: 1, amount: 0.1 }, 42, {
      id: 1,
      fullName: 'O',
    });

    // 0.3 - 0.1 = 0.2 (sin IEEE 754).
    const bankUpdate = updates.find((u) => u.entity === 'Bank');
    expect(bankUpdate?.patch.balance).toBe(0.2);
  });

  it('toda la operación ocurre dentro de UNA transacción', async () => {
    seedPurchase(1, 42);
    seedCredit(1, { total: 1000, paid: 0, balance: 1000 });
    seedBank(1, 42, 5000);

    await action.execute(1, { source_type: 'bank', source_id: 1, amount: 100 }, 42, {
      id: 1,
      fullName: 'O',
    });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });
});
