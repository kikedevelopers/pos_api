import { UnprocessableEntityException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { TransferCashAction } from '../actions/transfer-cash.action';
import type { TransferCashDto } from '../dto/transfer-cash.dto';

/**
 * Tests unitarios de `TransferCashAction` adaptados al modelo PERMANENTE.
 *
 * - La caja del actor se resuelve auto por `(company_id, user_id)`.
 *   `getOrCreateCashRegisterForUser` la crea con balance=0 si no existe.
 * - El balance vive en `cash_registers.balance` y se mutea con UPDATE.
 */
describe('TransferCashAction', () => {
  let action: TransferCashAction;
  let transactionSpy: jest.Mock;
  let recordSpy: jest.Mock;

  let saves: Array<{ entity: string; payload: Record<string, unknown> }>;
  let updates: Array<{
    entity: string;
    where: Record<string, unknown>;
    patch: Record<string, unknown>;
  }>;

  let banks: Map<
    string,
    { id: string; company_id: string; name: string; balance: number; is_archived: boolean }
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
          if (entityName === 'CashRegister') {
            const key = `${String(where.company_id)}|${String(where.user_id)}`;
            const cr = cashRegisters.get(key);
            return Promise.resolve(cr ?? null);
          }
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
          return Promise.resolve(null);
        },
      ),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_entity: { name?: string } | string, input: Record<string, unknown>) => {
        return input;
      }),
      save: jest.fn((entity: { name?: string } | string, payload: Record<string, unknown>) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        saves.push({ entity: entityName, payload });
        return Promise.resolve({ ...payload, id: payload.id ?? '777' });
      }),
      getRepository: jest.fn((entity: { name?: string } | string) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        return {
          save: (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
            saves.push({ entity: entityName, payload });
            return Promise.resolve({ ...payload, id: '777' });
          },
        };
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
            const b = banks.get(key);
            if (b && typeof patch.balance === 'number') {
              banks.set(key, { ...b, balance: patch.balance });
            }
          }
          if (entityName === 'Wallet') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            const w = wallets.get(key);
            if (w && typeof patch.balance === 'number') {
              wallets.set(key, { ...w, balance: patch.balance });
            }
          }
          if (entityName === 'CashRegister') {
            for (const [key, cr] of cashRegisters.entries()) {
              if (cr.id === String(where.id) && cr.company_id === String(where.company_id)) {
                cashRegisters.set(key, {
                  ...cr,
                  ...(typeof patch.balance === 'number' ? { balance: patch.balance } : {}),
                });
                break;
              }
            }
          }
          return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
        },
      ),
    };

    // Stub `dataSource.transaction(...)`: el action ahora invoca con
    // `transaction('SERIALIZABLE', cb)` vía `runSerializableWithRetry`,
    // así que el primer argumento puede ser el nivel de aislamiento
    // (string) o el callback. Tomamos siempre el último arg como callback.
    transactionSpy = jest.fn(async (...args: unknown[]) => {
      const cb = args[args.length - 1] as (m: typeof managerMock) => Promise<unknown>;
      return cb(managerMock);
    });
    recordSpy = jest.fn().mockResolvedValue(undefined);

    const dataSourceMock = { transaction: transactionSpy };
    const financialMovementsServiceMock = { record: recordSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransferCashAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: FinancialMovementsService, useValue: financialMovementsServiceMock },
      ],
    }).compile();

    action = module.get(TransferCashAction);
  });

  function seedBank(id: number, companyId: number, balance: number, isArchived = false): void {
    banks.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      name: `Bank ${id}`,
      balance,
      is_archived: isArchived,
    });
  }
  function seedWallet(id: number, companyId: number, balance: number, isArchived = false): void {
    wallets.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      name: `Wallet ${id}`,
      balance,
      is_archived: isArchived,
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

  const baseDto = (overrides: Partial<TransferCashDto> = {}): TransferCashDto => ({
    destinationType: 'wallet',
    destinationId: 10,
    amount: 100,
    ...overrides,
  });

  const actor = { id: 7, fullName: 'Cajero Test' };

  it('destinationType="user" → 422 UNSUPPORTED_DESTINATION (sin tocar DB)', async () => {
    seedCashRegisterForUser(1, 42, actor.id, 500);
    seedWallet(10, 42, 0);

    await expect(
      action.execute(baseDto({ destinationType: 'user' }), 42, actor),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(transactionSpy).not.toHaveBeenCalled();
    expect(saves.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it('amount <= 0 → 422', async () => {
    seedCashRegisterForUser(1, 42, actor.id, 500);
    seedWallet(10, 42, 0);

    await expect(action.execute(baseDto({ amount: 0 }), 42, actor)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(action.execute(baseDto({ amount: -1 }), 42, actor)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('saldo insuficiente en caja → 422 con balance disponible formateado', async () => {
    seedCashRegisterForUser(1, 42, actor.id, 100);
    seedWallet(10, 42, 0);

    await expect(action.execute(baseDto({ amount: 150 }), 42, actor)).rejects.toThrow(
      /Saldo insuficiente.*100\.00/,
    );

    expect(saves.find((s) => s.entity === 'CashRegisterLog')).toBeUndefined();
    expect(updates.find((u) => u.entity === 'Wallet')).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('wallet destino archivado → 404 (filtro is_archived=false impide cobrar)', async () => {
    seedCashRegisterForUser(1, 42, actor.id, 500);
    seedWallet(10, 42, 0, true);

    await expect(action.execute(baseDto(), 42, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('wallet destino de OTRA company → 404 (aislamiento multi-tenant)', async () => {
    seedCashRegisterForUser(1, 42, actor.id, 500);
    seedWallet(10, 99, 0);

    await expect(action.execute(baseDto(), 42, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('happy path wallet: UPDATE balance caja, log OUT, balance wallet aumenta, FM TRANSFER', async () => {
    seedCashRegisterForUser(1, 42, actor.id, 250);
    seedWallet(10, 42, 1000);

    const result = await action.execute(baseDto({ amount: 100 }), 42, actor);

    expect(result.message).toBe('Traslado completado exitosamente');
    expect(transactionSpy).toHaveBeenCalledTimes(1);

    // UPDATE balance origen (caja): 250 - 100 = 150.
    const crUpdate = updates.find((u) => u.entity === 'CashRegister');
    expect(crUpdate?.patch.balance).toBe(150);

    // Log OUT en cash_register_logs.
    const cashLog = saves.find((s) => s.entity === 'CashRegisterLog');
    expect(cashLog).toBeDefined();
    expect(cashLog?.payload.direction).toBe('OUT');
    expect(cashLog?.payload.affects_balance).toBe(true);
    expect(cashLog?.payload.amount).toBe(100);
    expect(cashLog?.payload.cash_register_id).toBe('1');

    // Wallet destino actualizado a 1000 + 100 = 1100.
    const walletUpdate = updates.find((u) => u.entity === 'Wallet');
    expect(walletUpdate?.patch.balance).toBe(1100);

    // FinancialMovement TRANSFER.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const fmArgs = (recordSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(fmArgs.movement_type).toBe('TRANSFER');
    expect(fmArgs.concept).toBe('TRANSFER');
    expect(fmArgs.source_type).toBe('cash_register');
    expect(fmArgs.source_id).toBe(1);
    expect(fmArgs.destination_type).toBe('wallet');
    expect(fmArgs.destination_id).toBe(10);
    expect(fmArgs.amount).toBe(100);
    expect(String(fmArgs.reference_code)).toMatch(/^POS-TRF-/);
    expect(fmArgs.companyId).toBe(42);
  });

  it('happy path bank: destination_type="bank" propagado al FinancialMovement', async () => {
    seedCashRegisterForUser(1, 42, actor.id, 500);
    seedBank(20, 42, 0);

    await action.execute(baseDto({ destinationType: 'bank', destinationId: 20 }), 42, actor);

    const fmArgs = (recordSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(fmArgs.destination_type).toBe('bank');
    expect(fmArgs.destination_id).toBe(20);

    const bankUpdate = updates.find((u) => u.entity === 'Bank');
    expect(bankUpdate?.patch.balance).toBe(100);
  });
});
