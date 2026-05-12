import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

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
  let updates: Array<{
    entity: string;
    where: Record<string, string>;
    patch: Record<string, unknown>;
  }>;
  let accounts: Map<string, { id: number; name: string; balance: number }>;

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

    transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
      cb(managerMock),
    );
    recordSpy = jest.fn().mockResolvedValue(undefined);

    const dataSourceMock = { transaction: transactionSpy };
    const financialMovementsServiceMock = { record: recordSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransferAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: FinancialMovementsService, useValue: financialMovementsServiceMock },
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

  it('rechaza destinationType="user" con 422 + code UNSUPPORTED_DESTINATION', async () => {
    seedWallet(1, 100, 1);
    let caught: unknown = null;
    try {
      await action.execute(
        {
          sourceType: 'wallet',
          sourceId: 1,
          // Cast porque el DTO acepta 'user' pero el action lo rechaza.
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
    expect(response.payload?.code).toBe('UNSUPPORTED_DESTINATION');
    // No debe haberse iniciado ninguna transacción.
    expect(transactionSpy).not.toHaveBeenCalled();
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
