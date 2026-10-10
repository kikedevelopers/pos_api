import { ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { Employee } from '@/modules/employees/entities/employee.entity';
import { AssertCanChargeOrdersAction } from '../assert-can-charge-orders.action';
import type {
  PermissionActor,
  ResolveEffectivePermissionsAction,
} from '../resolve-effective-permissions.action';

// Capacidad efectiva = owner/superadmin || rol concede canViewAllSales ||
// employee.can_charge_orders. El flag es override solo para roles no elevados.
function buildAction(opts: {
  effective?: string[];
  employee?: Partial<Employee> | null;
}) {
  const employeesRepo = {
    findOne: jest.fn().mockResolvedValue(opts.employee ?? null),
  } as unknown as Repository<Employee>;
  const resolvePermissions = {
    execute: jest.fn().mockResolvedValue(opts.effective ?? []),
  } as unknown as ResolveEffectivePermissionsAction;
  const action = new AssertCanChargeOrdersAction(employeesRepo, resolvePermissions);
  return { action, employeesRepo, resolvePermissions };
}

const actor = (overrides: Partial<PermissionActor> = {}): PermissionActor => ({
  type: 'employee',
  account: 'employee' as PermissionActor['account'],
  user_id: 10,
  company_id: 8,
  ...overrides,
});

describe('AssertCanChargeOrdersAction', () => {
  it('owner pasa sin tocar DB ni resolver permisos', async () => {
    const { action, employeesRepo, resolvePermissions } = buildAction({});
    await expect(action.execute(actor({ type: 'owner' }))).resolves.toBeUndefined();
    expect(resolvePermissions.execute).not.toHaveBeenCalled();
    expect(employeesRepo.findOne).not.toHaveBeenCalled();
  });

  it('superadmin pasa sin tocar DB', async () => {
    const { action, employeesRepo } = buildAction({});
    await expect(action.execute(actor({ type: 'superadmin' }))).resolves.toBeUndefined();
    expect(employeesRepo.findOne).not.toHaveBeenCalled();
  });

  it('rol elevado (canViewAllSales) pasa sin consultar el flag per-empleado', async () => {
    const { action, employeesRepo } = buildAction({
      effective: ['canAccessPOS', 'canViewAllSales'],
    });
    await expect(action.execute(actor())).resolves.toBeUndefined();
    expect(employeesRepo.findOne).not.toHaveBeenCalled();
  });

  it('Vendedor (sin canViewAllSales) con flag ON pasa', async () => {
    const { action } = buildAction({
      effective: ['canAccessPOS', 'canAccessSalesReport'],
      employee: { can_charge_orders: true },
    });
    await expect(action.execute(actor())).resolves.toBeUndefined();
  });

  it('Vendedor con flag OFF es rechazado (CHARGE_ORDERS_NOT_ALLOWED)', async () => {
    const { action } = buildAction({
      effective: ['canAccessPOS', 'canAccessSalesReport'],
      employee: { can_charge_orders: false },
    });
    await expect(action.execute(actor())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('empleado sin fila (null) es rechazado', async () => {
    const { action } = buildAction({
      effective: ['canAccessPOS'],
      employee: null,
    });
    await expect(action.execute(actor())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('empleado sin company_id es rechazado sin consultar el flag', async () => {
    const { action, employeesRepo } = buildAction({ effective: ['canAccessPOS'] });
    await expect(action.execute(actor({ company_id: null }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(employeesRepo.findOne).not.toHaveBeenCalled();
  });
});
