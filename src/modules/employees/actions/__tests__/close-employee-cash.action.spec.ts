import type { DataSource } from 'typeorm';

jest.mock('../../internal/employee-lookups');
jest.mock('../../internal/employee-cash-register-lookup');

import { CloseEmployeeCashAction } from '../close-employee-cash.action';
import type { CloseCashAction } from '@/modules/pos-data/actions/close-cash.action';
import { findEmployeeInCompany } from '../../internal/employee-lookups';
import { getOrCreateEmployeeCashRegister } from '../../internal/employee-cash-register-lookup';

/**
 * `CloseEmployeeCashAction` no reimplementa el cierre: resuelve el empleado + su
 * caja (user_id) y delega en `CloseCashAction` con el target del empleado y su
 * etiqueta, dejando el actor (admin) como created_by.
 */
describe('CloseEmployeeCashAction', () => {
  const buildAction = () => {
    const dataSource = {
      transaction: jest.fn(async (cb: (m: unknown) => unknown) => cb({})),
    } as unknown as DataSource;
    const closeResult = { message: 'ok', moved_amount: 190000, difference: -10000, new_balance: 100000 };
    const closeCashAction = {
      execute: jest.fn().mockResolvedValue(closeResult),
    } as unknown as CloseCashAction;
    return {
      action: new CloseEmployeeCashAction(dataSource, closeCashAction),
      closeCashAction,
      closeResult,
    };
  };

  beforeEach(() => {
    (findEmployeeInCompany as jest.Mock).mockResolvedValue({ id: '7', name: 'DIANA BOLAÑOS' });
    (getOrCreateEmployeeCashRegister as jest.Mock).mockResolvedValue({ id: '42', user_id: '15' });
  });

  it('delega en CloseCashAction con el target del empleado (user_id + etiqueta)', async () => {
    const { action, closeCashAction, closeResult } = buildAction();
    const dto = { reconcile: true, counted_amount: 290000, amount_to_transfer: 0 } as never;
    const actor = { id: 13, fullName: 'Enrique Pacheco' };

    const result = await action.execute(7, 13, dto, actor, 'key-1');

    expect(result).toBe(closeResult);
    expect(closeCashAction.execute).toHaveBeenCalledWith(dto, 13, actor, 'key-1', {
      targetUserId: 15,
      targetLabel: 'Caja de DIANA BOLAÑOS',
    });
  });

  it('resuelve empleado y caja dentro de una transacción antes de cerrar', async () => {
    const { action } = buildAction();
    await action.execute(7, 13, {} as never, { id: 13, fullName: 'Admin' });

    expect(findEmployeeInCompany).toHaveBeenCalledWith(expect.anything(), 7, 13);
    expect(getOrCreateEmployeeCashRegister).toHaveBeenCalledWith(
      expect.anything(),
      { id: '7', name: 'DIANA BOLAÑOS' },
      13,
    );
  });

  it('propaga null como idempotencyKey por defecto', async () => {
    const { action, closeCashAction } = buildAction();
    await action.execute(7, 13, {} as never, { id: 13, fullName: 'Admin' });
    expect((closeCashAction.execute as jest.Mock).mock.calls[0][3]).toBeNull();
  });
});
