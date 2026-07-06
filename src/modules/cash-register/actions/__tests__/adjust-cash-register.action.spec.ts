import type { DataSource } from 'typeorm';

import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import type { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { CashRegister } from '../../entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '../../entities/cash-register-log.entity';
import { AdjustCashRegisterAction } from '../adjust-cash-register.action';

/**
 * Construye la action con un `manager` transaccional simulado.
 *
 * - `manager.findOne` devuelve la caja del actor (lo que resuelve
 *   `getOrCreateCashRegisterForUser` cuando la caja ya existe).
 * - `manager.update` / `manager.save` son jest.fn observables.
 * - `manager.create` es identidad (devuelve el objeto tal cual).
 * - `financialMovementsService.record` devuelve un movimiento marcador.
 */
function buildAction(currentBalance: number) {
  const register = {
    id: '10',
    company_id: '8',
    user_id: '3',
    balance: currentBalance,
    base_amount: 0,
  } as unknown as CashRegister;

  const manager = {
    findOne: jest.fn().mockResolvedValue(register),
    update: jest.fn().mockResolvedValue(undefined),
    create: jest.fn((_entity: unknown, data: unknown) => data),
    save: jest.fn(async (_entity: unknown, data: unknown) => ({ id: '99', ...(data as object) })),
  };

  const dataSource = {
    transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => cb(manager)),
  } as unknown as DataSource;

  const recordedMovement = { id: '77' };
  const financialMovementsService = {
    record: jest.fn().mockResolvedValue(recordedMovement),
  } as unknown as FinancialMovementsService;

  const action = new AdjustCashRegisterAction(dataSource, financialMovementsService);

  return { action, manager, financialMovementsService, register, recordedMovement };
}

const ACTOR = { id: 3, fullName: 'Owner Uno' };

describe('AdjustCashRegisterAction', () => {
  it('target > actual: log IN por la diferencia, balance = target, movimiento INCOME a cash_register', async () => {
    const { action, manager, financialMovementsService } = buildAction(50_000);

    const result = await action.execute(8, 3, 75_000, 'Conteo manual', ACTOR);

    // Balance queda en el target, filtrado multi-tenant por company_id.
    expect(manager.update).toHaveBeenCalledWith(
      CashRegister,
      { id: '10', company_id: '8' },
      { balance: 75_000 },
    );

    // CashRegisterLog IN por la diferencia absoluta.
    expect(manager.save).toHaveBeenCalledWith(
      CashRegisterLog,
      expect.objectContaining({
        company_id: '8',
        cash_register_id: '10',
        type: CashRegisterLogType.ADMIN_ADJUSTMENT,
        direction: 'IN',
        amount: 25_000,
        affects_balance: true,
        description: 'Conteo manual',
      }),
    );

    // FinancialMovement INCOME con destination = cash_register.
    expect(financialMovementsService.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        companyId: 8,
        amount: 25_000,
        movement_type: MovementType.INCOME,
        concept: MovementConcept.ADJUSTMENT,
        destination_type: 'cash_register',
        destination_id: 10,
        source_type: null,
        source_id: null,
      }),
    );

    expect(result.previous_balance).toBe(50_000);
    expect(result.new_balance).toBe(75_000);
    expect(result.difference).toBe(25_000);
    expect(result.log).not.toBeNull();
    expect(result.movement).not.toBeNull();
  });

  it('target < actual: log OUT por la diferencia, balance = target, movimiento EXPENSE desde cash_register', async () => {
    const { action, manager, financialMovementsService } = buildAction(80_000);

    const result = await action.execute(8, 3, 30_000, undefined, ACTOR);

    expect(manager.update).toHaveBeenCalledWith(
      CashRegister,
      { id: '10', company_id: '8' },
      { balance: 30_000 },
    );

    expect(manager.save).toHaveBeenCalledWith(
      CashRegisterLog,
      expect.objectContaining({
        direction: 'OUT',
        amount: 50_000,
        affects_balance: true,
        // Sin reason → descripción por defecto.
        description: 'Ajuste administrativo',
      }),
    );

    expect(financialMovementsService.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        amount: 50_000,
        movement_type: MovementType.EXPENSE,
        concept: MovementConcept.ADJUSTMENT,
        source_type: 'cash_register',
        source_id: 10,
        destination_type: null,
        destination_id: null,
      }),
    );

    expect(result.previous_balance).toBe(80_000);
    expect(result.new_balance).toBe(30_000);
    expect(result.difference).toBe(-50_000);
  });

  it('target == actual: no-op idempotente (sin update, sin log, sin movimiento)', async () => {
    const { action, manager, financialMovementsService } = buildAction(60_000);

    const result = await action.execute(8, 3, 60_000, 'no cambia', ACTOR);

    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(financialMovementsService.record).not.toHaveBeenCalled();

    expect(result.previous_balance).toBe(60_000);
    expect(result.new_balance).toBe(60_000);
    expect(result.difference).toBe(0);
    expect(result.log).toBeNull();
    expect(result.movement).toBeNull();
  });

  it('multi-tenant: el UPDATE del balance filtra por company_id', async () => {
    const { action, manager } = buildAction(0);

    await action.execute(8, 3, 10_000, undefined, ACTOR);

    expect(manager.update).toHaveBeenCalledWith(
      CashRegister,
      expect.objectContaining({ company_id: '8' }),
      { balance: 10_000 },
    );
  });
});
