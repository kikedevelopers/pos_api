import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { CreateExpenseAction } from '../actions/create-expense.action';
import type { CreateExpenseDto } from '../dto/create-expense.dto';

/**
 * Tests unitarios de `CreateExpenseAction` adaptados al modelo PERMANENTE de
 * `cash_registers`. La caja se resuelve por `(company_id, user_id)` con
 * UPDATE de balance + INSERT log `EXPENSE`.
 *
 * Escenarios cubiertos:
 *   1. Camino feliz desde banco.
 *   2. Camino feliz desde caja: UPDATE balance + INSERT log EXPENSE; sin FM.
 *   3. Saldo insuficiente → 422.
 *   4. Cuenta de otra company → 404.
 *   5. amount <= 0 → 422.
 *   6. UNA transacción.
 *   7. Big.js precision.
 */
describe('CreateExpenseAction', () => {
  let action: CreateExpenseAction;
  let transactionSpy: jest.Mock;
  let recordSpy: jest.Mock;

  let creates: Array<{ entity: string; input: Record<string, unknown> }>;
  let saves: Array<{ entity: string; payload: Record<string, unknown> }>;
  let updates: Array<{
    entity: string;
    where: Record<string, unknown>;
    patch: Record<string, unknown>;
  }>;

  let banks: Map<
    string,
    {
      id: string;
      company_id: string;
      name: string;
      account_number: string;
      balance: number;
      is_archived: boolean;
    }
  >;
  let wallets: Map<
    string,
    { id: string; company_id: string; name: string; balance: number; is_archived: boolean }
  >;
  let cashRegisters: Map<
    string,
    { id: string; company_id: string; user_id: string; balance: number; base_amount: number }
  >;

  beforeEach(async () => {
    creates = [];
    saves = [];
    updates = [];

    banks = new Map();
    wallets = new Map();
    cashRegisters = new Map();

    const managerMock = {
      findOne: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const where = options.where;

          if (entityName === 'Bank') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            const bank = banks.get(key);
            if (!bank || (where.is_archived === false && bank.is_archived)) {
              return Promise.resolve(null);
            }
            return Promise.resolve(bank);
          }
          if (entityName === 'Wallet') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            const wallet = wallets.get(key);
            if (!wallet || (where.is_archived === false && wallet.is_archived)) {
              return Promise.resolve(null);
            }
            return Promise.resolve(wallet);
          }
          if (entityName === 'CashRegister') {
            // Modelo PERMANENTE: lookup por (company_id, user_id).
            const key = `${String(where.company_id)}|${String(where.user_id)}`;
            const cr = cashRegisters.get(key);
            return Promise.resolve(cr ?? null);
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
        if (entityName === 'Expense') {
          return Promise.resolve({
            ...payload,
            id: '300',
            created_at: new Date('2026-05-12T10:00:00.000Z'),
            updated_at: new Date('2026-05-12T10:00:00.000Z'),
            expense_date: payload.expense_date ?? new Date('2026-05-12T10:00:00.000Z'),
          });
        }
        return Promise.resolve({ ...payload, id: '777' });
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
          if (entityName === 'Wallet') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            const wallet = wallets.get(key);
            if (wallet && typeof patch.balance === 'number') {
              wallets.set(key, { ...wallet, balance: patch.balance });
            }
          }
          if (entityName === 'CashRegister') {
            for (const [key, cr] of cashRegisters.entries()) {
              if (cr.id === String(where.id) && cr.company_id === String(where.company_id)) {
                cashRegisters.set(key, {
                  ...cr,
                  ...(typeof patch.balance === 'number' ? { balance: patch.balance } : {}),
                  ...(typeof patch.base_amount === 'number'
                    ? { base_amount: patch.base_amount }
                    : {}),
                });
                break;
              }
            }
          }
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
        CreateExpenseAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: FinancialMovementsService, useValue: financialMovementsServiceMock },
      ],
    }).compile();

    action = module.get(CreateExpenseAction);
  });

  function seedBank(id: number, companyId: number, balance: number): void {
    banks.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      name: `Bank ${id}`,
      account_number: `00${id}-00${id}`,
      balance,
      is_archived: false,
    });
  }
  function seedWallet(id: number, companyId: number, balance: number): void {
    wallets.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      name: `Wallet ${id}`,
      balance,
      is_archived: false,
    });
  }
  function seedCashRegisterForUser(
    id: number,
    companyId: number,
    userId: number,
    balance: number,
  ): void {
    cashRegisters.set(`${companyId}|${userId}`, {
      id: String(id),
      company_id: String(companyId),
      user_id: String(userId),
      balance,
      base_amount: 0,
    });
  }

  const baseDto = (overrides: Partial<CreateExpenseDto> = {}): CreateExpenseDto => ({
    description: 'Pago de luz',
    amount: 150,
    source_type: 'bank',
    source_id: 1,
    ...overrides,
  });

  it('camino feliz desde banco: debita balance, crea Expense, registra FinancialMovement(EXPENSE)', async () => {
    seedBank(1, 42, 1000);

    const expense = await action.execute(baseDto(), 42, { id: 7, fullName: 'Kike Pacheco' });

    const bankUpdate = updates.find((u) => u.entity === 'Bank');
    expect(bankUpdate?.patch.balance).toBe(850);

    const expenseCreate = creates.find((c) => c.entity === 'Expense');
    expect(expenseCreate?.input.company_id).toBe('42');
    expect(expenseCreate?.input.amount).toBe(150);
    expect(expenseCreate?.input.source_type).toBe('bank');
    expect(expenseCreate?.input.source_id).toBe('1');
    expect(expenseCreate?.input.source_name).toBe('Bank 1 - 001-001');
    expect(expenseCreate?.input.created_by).toBe('Kike Pacheco');
    expect(expenseCreate?.input.is_archived).toBe(false);
    expect(Number(expense.id)).toBe(300);

    expect(recordSpy).toHaveBeenCalledTimes(1);
    const calls = recordSpy.mock.calls as Array<[unknown, Record<string, unknown>]>;
    const fmArgs = calls[0]?.[1];
    if (!fmArgs) {
      throw new Error('Expected record call');
    }
    expect(fmArgs.movement_type).toBe('EXPENSE');
    expect(fmArgs.concept).toBe('EXPENSE');
    expect(fmArgs.source_type).toBe('bank');
    expect(fmArgs.source_id).toBe(1);
    expect(fmArgs.amount).toBe(150);
    expect(fmArgs.destination_type).toBeUndefined();
  });

  it('desde caja: UPDATE balance + INSERT log EXPENSE; NO FinancialMovement (paridad PlacePos)', async () => {
    // user_id 7 → caja id=10 con balance 1000.
    seedCashRegisterForUser(10, 42, 7, 1000);

    await action.execute(baseDto({ source_type: 'cash_register', source_id: 0, amount: 200 }), 42, {
      id: 7,
      fullName: 'O',
    });

    // 1. UPDATE balance → 800.
    const crUpdate = updates.find((u) => u.entity === 'CashRegister');
    expect(crUpdate?.patch.balance).toBe(800);

    // 2. Log EXPENSE OUT.
    const logSave = saves.find((s) => s.entity === 'CashRegisterLog');
    expect(logSave).toBeDefined();
    expect(logSave?.payload.type).toBe('EXPENSE');
    expect(logSave?.payload.direction).toBe('OUT');
    expect(logSave?.payload.amount).toBe(200);
    expect(logSave?.payload.affects_balance).toBe(true);
    expect(logSave?.payload.company_id).toBe('42');
    expect(logSave?.payload.cash_register_id).toBe('10');

    // 3. NO se crea FinancialMovement (paridad PlacePos).
    expect(recordSpy).not.toHaveBeenCalled();

    // 4. Expense queda con source resuelto al id de la caja del actor.
    const expenseCreate = creates.find((c) => c.entity === 'Expense');
    expect(expenseCreate?.input.source_type).toBe('cash_register');
    expect(expenseCreate?.input.source_id).toBe('10');
    expect(expenseCreate?.input.source_name).toBe('Caja');
  });

  it('saldo insuficiente en banco → 422', async () => {
    seedBank(1, 42, 100);

    await expect(
      action.execute(baseDto({ amount: 500 }), 42, { id: 7, fullName: 'O' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(saves.find((s) => s.entity === 'Expense')).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('cuenta de otra company → 404 (aislamiento multi-tenant)', async () => {
    seedBank(1, 99, 1000);

    await expect(
      action.execute(baseDto({ source_id: 1 }), 42, { id: 7, fullName: 'O' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(saves.find((s) => s.entity === 'Expense')).toBeUndefined();
  });

  it('amount <= 0 → 422', async () => {
    seedBank(1, 42, 1000);
    await expect(
      action.execute(baseDto({ amount: 0 }), 42, { id: 7, fullName: 'O' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('toda la operación ocurre dentro de UNA transacción', async () => {
    seedBank(1, 42, 1000);
    await action.execute(baseDto(), 42, { id: 7, fullName: 'O' });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it('Big.js: 0.1 + 0.2 sin error IEEE 754 en debitación', async () => {
    seedWallet(1, 42, 0.3);

    await action.execute(baseDto({ source_type: 'wallet', source_id: 1, amount: 0.1 }), 42, {
      id: 7,
      fullName: 'O',
    });

    const walletUpdate = updates.find((u) => u.entity === 'Wallet');
    expect(walletUpdate?.patch.balance).toBe(0.2);
  });
});
