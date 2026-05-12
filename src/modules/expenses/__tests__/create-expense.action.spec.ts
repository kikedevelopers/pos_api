import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { CreateExpenseAction } from '../actions/create-expense.action';
import type { CreateExpenseDto } from '../dto/create-expense.dto';

/**
 * Tests unitarios de `CreateExpenseAction`. Cubrimos:
 *
 *   1. Camino feliz pagado desde un banco: debita balance, inserta Expense,
 *      registra FinancialMovement(EXPENSE, EXPENSE).
 *   2. Camino feliz pagado desde caja: NO inserta FinancialMovement (el
 *      CashRegisterLog cumple la función — paridad PlacePos).
 *   3. Saldo insuficiente → 422.
 *   4. Cuenta de otra company → 404 (multi-tenant aislamiento).
 *   5. amount <= 0 → 422.
 *   6. Toda la operación ocurre dentro de UNA transacción.
 *   7. Big.js: 0.1 + 0.2 sin error IEEE 754.
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
    { id: string; company_id: string; status: string; opening_balance: number }
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
            // requireOpenCashRegisterForUpdate filtra por company_id + status='OPEN'.
            for (const cr of cashRegisters.values()) {
              if (cr.company_id === String(where.company_id) && cr.status === 'OPEN') {
                return Promise.resolve(cr);
              }
            }
            return Promise.resolve(null);
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
  function seedOpenCashRegister(id: number, companyId: number, openingBalance: number): void {
    cashRegisters.set(String(id), {
      id: String(id),
      company_id: String(companyId),
      status: 'OPEN',
      opening_balance: openingBalance,
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

    // 1. Bank balance: 1000 - 150 = 850.
    const bankUpdate = updates.find((u) => u.entity === 'Bank');
    expect(bankUpdate?.patch.balance).toBe(850);

    // 2. Expense creado con company_id, source_name snapshot, amount preciso.
    const expenseCreate = creates.find((c) => c.entity === 'Expense');
    expect(expenseCreate?.input.company_id).toBe('42');
    expect(expenseCreate?.input.amount).toBe(150);
    expect(expenseCreate?.input.source_type).toBe('bank');
    expect(expenseCreate?.input.source_id).toBe('1');
    expect(expenseCreate?.input.source_name).toBe('Bank 1 - 001-001');
    expect(expenseCreate?.input.created_by).toBe('Kike Pacheco');
    expect(expenseCreate?.input.is_archived).toBe(false);
    expect(Number(expense.id)).toBe(300);

    // 3. FinancialMovement (EXPENSE, EXPENSE) con source bank.
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

  it('desde caja: inserta CashRegisterLog y NO FinancialMovement (paridad PlacePos)', async () => {
    seedOpenCashRegister(10, 42, 1000);

    await action.execute(
      baseDto({ source_type: 'cash_register', source_id: 10, amount: 200 }),
      42,
      { id: 7, fullName: 'O' },
    );

    const logSave = saves.find((s) => s.entity === 'CashRegisterLog');
    expect(logSave).toBeDefined();
    expect(logSave?.payload.type).toBe('CASH_OUT');
    expect(logSave?.payload.direction).toBe('OUT');
    expect(logSave?.payload.amount).toBe(200);
    expect(logSave?.payload.affects_balance).toBe(true);
    expect(logSave?.payload.company_id).toBe('42');
    expect(logSave?.payload.cash_register_id).toBe('10');

    // El cash_register no genera FinancialMovement (paridad PlacePos).
    expect(recordSpy).not.toHaveBeenCalled();

    // Expense queda con source_name='Caja' y source_id resuelto al turno abierto.
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

    // No debe haberse insertado Expense ni movimiento.
    expect(saves.find((s) => s.entity === 'Expense')).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('cuenta de otra company → 404 (aislamiento multi-tenant)', async () => {
    seedBank(1, 99, 1000); // banco existe pero en company 99

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
    // 0.3 - 0.1 = 0.2 exacto (sin IEEE 754).
    expect(walletUpdate?.patch.balance).toBe(0.2);
  });
});
