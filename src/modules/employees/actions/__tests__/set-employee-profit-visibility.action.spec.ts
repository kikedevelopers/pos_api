import { BadRequestException, NotFoundException } from '@nestjs/common';
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
  it('cascada del principal: UPDATE con filtro multi-tenant y patch de los tres flags', async () => {
    const { action, manager } = buildAction();
    const before = {
      id: '5',
      company_id: '8',
      can_view_profit: false,
      can_view_product_margin: false,
      can_view_product_profit: false,
    } as Employee;
    const after = {
      ...before,
      can_view_profit: true,
      can_view_product_margin: true,
      can_view_product_profit: true,
    } as Employee;
    manager.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    const result = await action.execute(
      5,
      { can_view_profit: true, can_view_product_margin: true, can_view_product_profit: true },
      8,
    );

    expect(manager.update).toHaveBeenCalledWith(
      Employee,
      { id: '5', company_id: '8' },
      { can_view_profit: true, can_view_product_margin: true, can_view_product_profit: true },
    );
    expect(result.can_view_profit).toBe(true);
  });

  it('subtoggle aislado: patch solo con el subpermiso enviado', async () => {
    const { action, manager } = buildAction();
    const before = { id: '5', company_id: '8', can_view_product_margin: false } as Employee;
    const after = { ...before, can_view_product_margin: true } as Employee;
    manager.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    const result = await action.execute(5, { can_view_product_margin: true }, 8);

    expect(manager.update).toHaveBeenCalledWith(
      Employee,
      { id: '5', company_id: '8' },
      { can_view_product_margin: true },
    );
    expect(result.can_view_product_margin).toBe(true);
  });

  it('ignora campos undefined y arma el patch solo con los booleanos presentes', async () => {
    const { action, manager } = buildAction();
    const before = { id: '5', company_id: '8' } as Employee;
    manager.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce(before);

    await action.execute(5, { can_view_profit: false, can_view_product_profit: undefined }, 8);

    expect(manager.update).toHaveBeenCalledWith(
      Employee,
      { id: '5', company_id: '8' },
      { can_view_profit: false },
    );
  });

  it('lanza 400 y NO abre transacción si el patch queda vacío', async () => {
    const { action, manager } = buildAction();

    await expect(action.execute(5, {}, 8)).rejects.toBeInstanceOf(BadRequestException);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('lanza 404 y NO actualiza si el empleado no existe o es de otra company', async () => {
    const { action, manager } = buildAction();
    manager.findOne.mockResolvedValueOnce(null);

    await expect(action.execute(99, { can_view_profit: true }, 8)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(manager.update).not.toHaveBeenCalled();
  });
});
