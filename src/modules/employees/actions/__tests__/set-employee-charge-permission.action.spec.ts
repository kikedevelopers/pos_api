import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { Employee } from '../../entities/employee.entity';
import { SetEmployeeChargePermissionAction } from '../set-employee-charge-permission.action';

// Espejo de SetEmployeeCashVisibilityAction: UPDATE con filtro multi-tenant y
// patch can_charge_orders; 404 si el empleado no existe / es de otra company.
function buildAction() {
  const manager = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => cb(manager)),
  } as unknown as DataSource;
  return { action: new SetEmployeeChargePermissionAction(dataSource), manager };
}

describe('SetEmployeeChargePermissionAction', () => {
  it('concede el permiso: patch can_charge_orders=true con filtro multi-tenant', async () => {
    const { action, manager } = buildAction();
    const before = { id: '5', company_id: '8', can_charge_orders: false } as Employee;
    manager.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce({
      ...before,
      can_charge_orders: true,
    });

    const result = await action.execute(5, true, 8);

    expect(manager.update).toHaveBeenCalledWith(
      Employee,
      { id: '5', company_id: '8' },
      { can_charge_orders: true },
    );
    expect(result.can_charge_orders).toBe(true);
  });

  it('revoca el permiso: patch can_charge_orders=false', async () => {
    const { action, manager } = buildAction();
    const before = { id: '5', company_id: '8', can_charge_orders: true } as Employee;
    manager.findOne.mockResolvedValueOnce(before).mockResolvedValueOnce({
      ...before,
      can_charge_orders: false,
    });

    const result = await action.execute(5, false, 8);

    expect(manager.update).toHaveBeenCalledWith(
      Employee,
      { id: '5', company_id: '8' },
      { can_charge_orders: false },
    );
    expect(result.can_charge_orders).toBe(false);
  });

  it('lanza 404 y NO actualiza si el empleado no existe o es de otra company', async () => {
    const { action, manager } = buildAction();
    manager.findOne.mockResolvedValueOnce(null);

    await expect(action.execute(99, true, 8)).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.update).not.toHaveBeenCalled();
  });
});
