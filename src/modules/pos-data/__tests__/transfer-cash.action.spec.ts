import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { TransferCashAction } from '../actions/transfer-cash.action';
import type { TransferCashDto } from '../dto/transfer-cash.dto';

/**
 * Tests unitarios de `TransferCashAction`. Cubre los 6 escenarios críticos
 * señalados por el security-auditor de Fase 11 (MED-5).
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
    { id: string; company_id: string; status: string; opening_balance: number }
  >;
  let cashLogs: Array<{
    direction: 'IN' | 'OUT';
    amount: number;
    affects_balance: boolean;
    cash_register_id: string;
    company_id: string;
  }>;

  beforeEach(async () => {
    saves = [];
    updates = [];
    banks = new Map();
    wallets = new Map();
    cashRegisters = new Map();
    cashLogs = [];

    const managerMock = {
      findOne: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const where = options.where;
          if (entityName === 'CashRegister') {
            for (const cr of cashRegisters.values()) {
              if (cr.company_id === String(where.company_id) && cr.status === 'OPEN') {
                return Promise.resolve(cr);
              }
            }
            return Promise.resolve(null);
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
      find: jest.fn(
        (entity: { name?: string } | string, options: { where: Record<string, unknown> }) => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          if (entityName === 'CashRegisterLog') {
            const filtered = cashLogs.filter(
              (l) =>
                l.cash_register_id === String(options.where.cash_register_id) &&
                l.company_id === String(options.where.company_id) &&
                l.affects_balance === true,
            );
            return Promise.resolve(filtered);
          }
          return Promise.resolve([]);
        },
      ),
      getRepository: jest.fn((entity: { name?: string } | string) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        return {
          save: (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
            saves.push({ entity: entityName, payload });
            if (entityName === 'CashRegisterLog') {
              cashLogs.push({
                direction: payload.direction as 'IN' | 'OUT',
                amount: payload.amount as number,
                affects_balance: payload.affects_balance as boolean,
                cash_register_id: String(payload.cash_register_id),
                company_id: String(payload.company_id),
              });
            }
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
  function seedOpenCashRegister(
    id: number,
    companyId: number,
    opening: number,
    logs: { direction: 'IN' | 'OUT'; amount: number }[] = [],
  ): void {
    cashRegisters.set(String(id), {
      id: String(id),
      company_id: String(companyId),
      status: 'OPEN',
      opening_balance: opening,
    });
    for (const log of logs) {
      cashLogs.push({
        direction: log.direction,
        amount: log.amount,
        affects_balance: true,
        cash_register_id: String(id),
        company_id: String(companyId),
      });
    }
  }

  const baseDto = (overrides: Partial<TransferCashDto> = {}): TransferCashDto => ({
    destinationType: 'wallet',
    destinationId: 10,
    amount: 100,
    ...overrides,
  });

  const actor = { id: 7, fullName: 'Cajero Test' };

  it('destinationType="user" → 422 UNSUPPORTED_DESTINATION (sin tocar DB)', async () => {
    seedOpenCashRegister(1, 42, 500);
    seedWallet(10, 42, 0);

    await expect(
      action.execute(baseDto({ destinationType: 'user' }), 42, actor),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // No transacción abierta: el guard sucede ANTES de dataSource.transaction.
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(saves.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it('amount <= 0 → 422', async () => {
    seedOpenCashRegister(1, 42, 500);
    seedWallet(10, 42, 0);

    await expect(action.execute(baseDto({ amount: 0 }), 42, actor)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(action.execute(baseDto({ amount: -1 }), 42, actor)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('sin caja abierta → 404', async () => {
    // No seedOpenCashRegister
    seedWallet(10, 42, 0);

    await expect(action.execute(baseDto(), 42, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(saves.length).toBe(0);
  });

  it('saldo insuficiente en caja → 422 con balance disponible formateado', async () => {
    // Opening 100, sin logs → balance 100; intentamos transferir 150.
    seedOpenCashRegister(1, 42, 100);
    seedWallet(10, 42, 0);

    await expect(action.execute(baseDto({ amount: 150 }), 42, actor)).rejects.toThrow(
      /Saldo insuficiente.*100\.00/,
    );

    // No se llegó a insertar log ni actualizar destino.
    expect(saves.find((s) => s.entity === 'CashRegisterLog')).toBeUndefined();
    expect(updates.find((u) => u.entity === 'Wallet')).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('wallet destino archivado → 404 (filtro is_archived=false impide cobrar)', async () => {
    seedOpenCashRegister(1, 42, 500);
    seedWallet(10, 42, 0, true);

    await expect(action.execute(baseDto(), 42, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('wallet destino de OTRA company → 404 (aislamiento multi-tenant)', async () => {
    seedOpenCashRegister(1, 42, 500);
    seedWallet(10, 99, 0); // wallet existe en company 99, no 42.

    await expect(action.execute(baseDto(), 42, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('happy path wallet: log OUT en caja, balance wallet aumenta, FM TRANSFER registrado', async () => {
    // Opening 200, log IN 50 → balance 250.
    seedOpenCashRegister(1, 42, 200, [{ direction: 'IN', amount: 50 }]);
    seedWallet(10, 42, 1000);

    const result = await action.execute(baseDto({ amount: 100 }), 42, actor);

    expect(result.message).toBe('Traslado completado exitosamente');
    expect(transactionSpy).toHaveBeenCalledTimes(1);

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

    // FinancialMovement TRANSFER registrado con source=cash_register, dest=wallet.
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
    seedOpenCashRegister(1, 42, 500);
    seedBank(20, 42, 0);

    await action.execute(baseDto({ destinationType: 'bank', destinationId: 20 }), 42, actor);

    const fmArgs = (recordSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(fmArgs.destination_type).toBe('bank');
    expect(fmArgs.destination_id).toBe(20);

    const bankUpdate = updates.find((u) => u.entity === 'Bank');
    expect(bankUpdate?.patch.balance).toBe(100);
  });
});
