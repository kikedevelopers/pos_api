import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CashRegisterService } from '@/modules/cash-register/cash-register.service';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { TransferAction } from '../actions/transfer.action';

/**
 * Tests unitarios de `TransferAction`. Cubrimos invariantes clave:
 *
 *   1. Saldo insuficiente → UnprocessableEntityException con mensaje
 *      literal "Saldo insuficiente. Disponible: X" (paridad PlacePos).
 *   2. Source === destination (mismo tipo y id) → 422.
 *   3. amount <= 0 → 422.
 *   4. Cuenta inexistente → 404 (con mensaje del role correcto).
 *   5. Camino feliz: balances actualizados, dos FinancialMovement
 *      registrados con el mismo reference_code, par EXPENSE + INCOME.
 *   6. Toda la operación vive dentro de UNA transacción.
 */
describe('TransferAction', () => {
  let action: TransferAction;
  let transactionSpy: jest.Mock;
  let recordSpy: jest.Mock;
  let cashRecordSpy: jest.Mock;
  let updates: Array<{
    entity: string;
    where: Record<string, string>;
    patch: Record<string, unknown>;
  }>;
  let accounts: Map<
    string,
    { id: number; name: string; balance: number; type?: string; lastname?: string }
  >;

  beforeEach(async () => {
    updates = [];
    accounts = new Map();

    const managerMock = {
      findOne: jest.fn(
        (entity: { name?: string } | string, options: { where: Record<string, string> }) => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const key = `${entityName}|${options.where.id}|${options.where.company_id}`;
          const account = accounts.get(key);
          if (!account) {
            return Promise.resolve(null);
          }
          return Promise.resolve(account);
        },
      ),
      update: jest.fn(
        (
          entity: { name?: string } | string,
          where: Record<string, string>,
          patch: Record<string, unknown>,
        ) => {
          updates.push({
            entity: typeof entity === 'string' ? entity : (entity.name ?? 'Unknown'),
            where,
            patch,
          });
          // Reflect en el mock store para que un segundo findOne vea el balance nuevo.
          const key = `${typeof entity === 'string' ? entity : (entity.name ?? 'Unknown')}|${where.id}|${where.company_id}`;
          const existing = accounts.get(key);
          if (existing && typeof patch.balance === 'number') {
            accounts.set(key, { ...existing, balance: patch.balance });
          }
          return Promise.resolve();
        },
      ),
    };

    // El action invoca `dataSource.transaction('SERIALIZABLE', cb)` vía
    // `runSerializableWithRetry`. Tomamos siempre el último arg como cb.
    transactionSpy = jest.fn(async (...args: unknown[]) => {
      const cb = args[args.length - 1] as (m: typeof managerMock) => Promise<unknown>;
      return cb(managerMock);
    });
    recordSpy = jest.fn().mockResolvedValue(undefined);
    cashRecordSpy = jest.fn().mockImplementation(async (_manager, input) => ({
      cashRegisterId: 999,
      log: {
        id: '1',
        cash_register_id: '999',
        amount: input.amount,
        direction: input.direction,
        type: input.type,
        affects_balance: input.affects_balance,
        description: input.description,
        created_at: new Date(),
        created_by: input.created_by,
        created_by_id: input.created_by_id ? String(input.created_by_id) : null,
        company_id: String(input.companyId),
        invoice_id: null,
        payment_id: null,
        credit_note_id: null,
        is_credit_related: false,
      },
    }));

    const dataSourceMock = { transaction: transactionSpy };
    const financialMovementsServiceMock = { record: recordSpy };
    const cashRegisterServiceMock = { record: cashRecordSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransferAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: FinancialMovementsService, useValue: financialMovementsServiceMock },
        { provide: CashRegisterService, useValue: cashRegisterServiceMock },
      ],
    }).compile();

    action = module.get(TransferAction);
  });

  function seedWallet(id: number, balance: number, companyId: number, name = `W${id}`): void {
    accounts.set(`Wallet|${String(id)}|${String(companyId)}`, { id, name, balance });
  }
  function seedBank(id: number, balance: number, companyId: number, name = `B${id}`): void {
    accounts.set(`Bank|${String(id)}|${String(companyId)}`, { id, name, balance });
  }
  function seedUser(
    id: number,
    companyId: number,
    name = 'Juan',
    lastname = 'Pérez',
    type = 'employee',
  ): void {
    accounts.set(`User|${String(id)}|${String(companyId)}`, {
      id,
      name,
      lastname,
      type,
      balance: 0,
    });
  }
  function seedCashRegisterForLookup(
    cashRegisterId: number,
    companyId: number,
    balance: number,
  ): void {
    // El TransferAction relee la caja por id después del UPDATE para devolver
    // el balance final. Como el mock de cashRegisterService.record usa id 999,
    // sembramos esa fila aquí.
    accounts.set(`CashRegister|${String(cashRegisterId)}|${String(companyId)}`, {
      id: cashRegisterId,
      name: 'cash',
      balance,
    });
  }

  it('rechaza amount <= 0 con 422 antes de tocar DB', async () => {
    await expect(
      action.execute(
        {
          sourceType: 'wallet',
          sourceId: 1,
          destinationType: 'bank',
          destinationId: 1,
          amount: 0,
        },
        1,
        { id: 1, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('rechaza destinationType="user" cuando source es bank con 422 + code INVALID_DESTINATION_FOR_SOURCE', async () => {
    seedBank(1, 100, 1);
    let caught: unknown = null;
    try {
      await action.execute(
        {
          sourceType: 'bank',
          sourceId: 1,
          destinationType: 'user',
          destinationId: 7,
          amount: 10,
        },
        1,
        { id: 1, fullName: 'O' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnprocessableEntityException);
    const response = (caught as UnprocessableEntityException).getResponse() as {
      payload?: { code?: string };
    };
    expect(response.payload?.code).toBe('INVALID_DESTINATION_FOR_SOURCE');
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('camino feliz wallet → user: debita wallet, acredita caja del user, 2 FM + 1 CashRegisterLog', async () => {
    seedWallet(1, 100, 42, 'Caja Efectivo');
    seedUser(7, 42, 'Juan', 'Pérez', 'employee');
    seedCashRegisterForLookup(999, 42, 30); // balance final esperado tras el +30

    const result = await action.execute(
      {
        sourceType: 'wallet',
        sourceId: 1,
        destinationType: 'user',
        destinationId: 7,
        amount: 30,
      },
      42,
      { id: 9, fullName: 'Owner Boss' },
    );

    // El UPDATE de balance de la wallet ocurre dentro del action (no del mock
    // de cashRegisterService.record).
    const walletUpdate = updates.find((u) => u.entity === 'Wallet');
    expect(walletUpdate?.patch.balance).toBe(70);

    // CashRegisterService.record fue llamado UNA vez con CASH_TRANSFER_IN.
    expect(cashRecordSpy).toHaveBeenCalledTimes(1);
    const cashCall = cashRecordSpy.mock.calls[0]?.[1] as {
      type: string;
      direction: string;
      affects_balance: boolean;
      userId: number;
      amount: number;
    };
    expect(cashCall.type).toBe('CASH_TRANSFER_IN');
    expect(cashCall.direction).toBe('IN');
    expect(cashCall.affects_balance).toBe(true);
    expect(cashCall.userId).toBe(7);

    // Dos FinancialMovement con destination_type='cash_register' y mismo
    // reference_code.
    expect(recordSpy).toHaveBeenCalledTimes(2);
    const fmCalls = recordSpy.mock.calls as Array<
      [
        unknown,
        {
          movement_type: string;
          destination_type: string;
          destination_id: number;
          reference_code: string;
        },
      ]
    >;
    const fmFirst = fmCalls[0]?.[1];
    const fmSecond = fmCalls[1]?.[1];
    if (!fmFirst || !fmSecond) {
      throw new Error('Expected two financial movement record calls');
    }
    expect(fmFirst.movement_type).toBe('EXPENSE');
    expect(fmSecond.movement_type).toBe('INCOME');
    expect(fmFirst.destination_type).toBe('cash_register');
    expect(fmSecond.destination_type).toBe('cash_register');
    expect(fmFirst.destination_id).toBe(999);
    expect(fmFirst.reference_code).toBe(fmSecond.reference_code);

    expect(result.destination.type).toBe('user');
    expect(result.destination.id).toBe(7);
    expect(result.message).toContain('Juan Pérez');
  });

  it('lanza 404 si el user destino no pertenece a la company', async () => {
    seedWallet(1, 100, 42, 'Caja Efectivo');
    // No sembramos User|7|42 — distinto company_id.

    await expect(
      action.execute(
        {
          sourceType: 'wallet',
          sourceId: 1,
          destinationType: 'user',
          destinationId: 7,
          amount: 10,
        },
        42,
        { id: 9, fullName: 'Owner Boss' },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechaza source === destination con 422', async () => {
    await expect(
      action.execute(
        {
          sourceType: 'wallet',
          sourceId: 7,
          destinationType: 'wallet',
          destinationId: 7,
          amount: 10,
        },
        1,
        { id: 1, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('lanza 404 si la cuenta origen no existe en la company', async () => {
    seedBank(2, 100, 1);
    await expect(
      action.execute(
        {
          sourceType: 'wallet',
          sourceId: 1,
          destinationType: 'bank',
          destinationId: 2,
          amount: 10,
        },
        1,
        { id: 1, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lanza 422 con mensaje literal de PlacePos si el saldo es insuficiente', async () => {
    seedWallet(1, 5, 1);
    seedBank(2, 0, 1);

    await expect(
      action.execute(
        {
          sourceType: 'wallet',
          sourceId: 1,
          destinationType: 'bank',
          destinationId: 2,
          amount: 10,
        },
        1,
        { id: 1, fullName: 'O' },
      ),
    ).rejects.toThrow(/Saldo insuficiente\. Disponible: 5\.00/);
  });

  it('camino feliz: actualiza balances y registra DOS FinancialMovement con mismo reference_code', async () => {
    seedWallet(1, 100, 42, 'Caja Principal');
    seedBank(2, 50, 42, 'Banco Mercantil');

    const result = await action.execute(
      {
        sourceType: 'wallet',
        sourceId: 1,
        destinationType: 'bank',
        destinationId: 2,
        amount: 30,
      },
      42,
      { id: 7, fullName: 'Kike Pacheco' },
    );

    // Dos updates de balance (source -> 70, destination -> 80).
    expect(updates).toHaveLength(2);
    expect(updates[0]?.patch.balance).toBe(70);
    expect(updates[1]?.patch.balance).toBe(80);

    // Dos FinancialMovement: EXPENSE (source) + INCOME (destination), mismo reference_code.
    expect(recordSpy).toHaveBeenCalledTimes(2);
    const calls = recordSpy.mock.calls as Array<
      [
        unknown,
        {
          movement_type: string;
          reference_code: string;
          concept: string;
          source_type: string;
          destination_type: string;
        },
      ]
    >;
    const first = calls[0]?.[1];
    const second = calls[1]?.[1];
    if (!first || !second) {
      throw new Error('Expected two record calls');
    }
    expect(first.movement_type).toBe('EXPENSE');
    expect(second.movement_type).toBe('INCOME');
    expect(first.concept).toBe('TRANSFER');
    expect(first.source_type).toBe('wallet');
    expect(first.destination_type).toBe('bank');
    expect(first.reference_code).toBe(second.reference_code);

    expect(result.source.balance).toBe(70);
    expect(result.destination.balance).toBe(80);
    expect(result.message).toContain('30.00');
    expect(result.message).toContain('Banco Mercantil');
  });

  it('toda la operación ocurre dentro de UNA transacción', async () => {
    seedWallet(1, 100, 1);
    seedBank(2, 0, 1);

    await action.execute(
      {
        sourceType: 'wallet',
        sourceId: 1,
        destinationType: 'bank',
        destinationId: 2,
        amount: 50,
      },
      1,
      { id: 1, fullName: 'O' },
    );

    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it('cálculo usa Big.js — sin errores de IEEE 754', async () => {
    seedWallet(1, 0.3, 1);
    seedBank(2, 0, 1);

    await action.execute(
      {
        sourceType: 'wallet',
        sourceId: 1,
        destinationType: 'bank',
        destinationId: 2,
        amount: 0.1,
      },
      1,
      { id: 1, fullName: 'O' },
    );

    // 0.3 - 0.1 = 0.2 exacto. Con `number` puro daría 0.19999999999999998.
    expect(updates[0]?.patch.balance).toBe(0.2);
  });
});
