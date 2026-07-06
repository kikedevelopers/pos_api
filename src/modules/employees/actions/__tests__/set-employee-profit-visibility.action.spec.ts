import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { Employee } from '../../entities/employee.entity';
import { SetEmployeeProfitVisibilityAction } from '../set-employee-profit-visibility.action';

/**
 * Manager transaccional simulado: `transaction(cb)` ejecuta el callback con un
 * `manager` cuyos `findOne`/`update` son jest.fn controlables por test.
 */
function buildAction() {
  const manager = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => cb(manager)),
  } as unknown as DataSource;
  return { action: new SetEmployeeProfitVisibilityAction(dataSource), manager };
}

describe('SetEmployeeProfitVisibilityAction', () => {
  it('concede el permiso: UPDATE con filtro multi-tenant y patch can_view_profit=true', async () => {
    const { action, manager } = buildAction();
    const before = { id: '5', company_id: '8', can_view_profit: false } as Employee;
    const after = { ...before, can_view_profit: true } as Employee;
    manager.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    const result = await action.execute(5, true, 8);

    expect(manager.update).toHaveBeenCalledWith(
      Employee,
      { id: '5', company_id: '8' },
      { can_view_profit: true },
    );
    expect(result.can_view_profit).toBe(true);
  });

  it('revoca el permiso: patch can_view_profit=false', async () => {
    const { action, manager } = buildAction();
    const before = { id: '5', company_id: '8', can_view_profit: true } as Employee;
    const after = { ...before, can_view_profit: false } as Employee;
    manager.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    const result = await action.execute(5, false, 8);

    expect(manager.update).toHaveBeenCalledWith(
      Employee,
      { id: '5', company_id: '8' },
      { can_view_profit: false },
    );
    expect(result.can_view_profit).toBe(false);
  });

  it('lanza 404 y NO actualiza si el empleado no existe o es de otra company', async () => {
    const { action, manager } = buildAction();
    manager.findOne.mockResolvedValueOnce(null);

    await expect(action.execute(99, true, 8)).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.update).not.toHaveBeenCalled();
  });
});
