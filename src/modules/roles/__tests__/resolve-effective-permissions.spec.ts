import type { Repository } from 'typeorm';

import type { Employee } from '@/modules/employees/entities/employee.entity';

import {
  type PermissionActor,
  ResolveEffectivePermissionsAction,
} from '../actions/resolve-effective-permissions.action';
import type { Role } from '../entities/role.entity';
import {
  LEGACY_EMPLOYEE_PERMISSIONS,
  PERMISSION_KEYS,
  type PermissionKey,
} from '../internal/permission-catalog';

/**
 * Tests unitarios de `ResolveEffectivePermissionsAction`.
 *
 * Cubren las 4 ramas + el aislamiento multi-tenant:
 *   - owner → las 22 keys.
 *   - superadmin → las 22 keys.
 *   - empleado CON rol → permisos del rol (filtrados a keys válidas).
 *   - empleado SIN rol (role_id null) → LEGACY.
 *   - empleado cuyo rol no se encuentra → LEGACY.
 *   - empleado no hallado en la company del JWT → LEGACY (aislamiento).
 *   - las queries SIEMPRE filtran por company_id del actor.
 *
 * Los repos se mockean: el de Employee y el de Role son `findOne` controlados.
 */
describe('ResolveEffectivePermissionsAction', () => {
  const makeAction = (opts: {
    employee?: Partial<Employee> | null;
    role?: Partial<Role> | null;
  }): {
    action: ResolveEffectivePermissionsAction;
    employeeFindOne: jest.Mock;
    roleFindOne: jest.Mock;
  } => {
    const employeeFindOne = jest.fn().mockResolvedValue(opts.employee ?? null);
    const roleFindOne = jest.fn().mockResolvedValue(opts.role ?? null);

    const employeesRepo = { findOne: employeeFindOne } as unknown as Repository<Employee>;
    const rolesRepo = { findOne: roleFindOne } as unknown as Repository<Role>;

    return {
      action: new ResolveEffectivePermissionsAction(employeesRepo, rolesRepo),
      employeeFindOne,
      roleFindOne,
    };
  };

  const ownerActor: PermissionActor = {
    type: 'owner',
    account: 'user',
    user_id: 1,
    company_id: 10,
  };
  const superadminActor: PermissionActor = {
    type: 'superadmin',
    account: 'user',
    user_id: 99,
    company_id: null,
  };
  const employeeActor: PermissionActor = {
    type: 'employee',
    account: 'employee',
    user_id: 50,
    company_id: 10,
  };

  it('owner → TODAS las 22 keys, sin tocar la BD', async () => {
    const { action, employeeFindOne, roleFindOne } = makeAction({});

    const perms = await action.execute(ownerActor);

    expect(perms).toEqual([...PERMISSION_KEYS]);
    expect(perms).toHaveLength(22);
    expect(employeeFindOne).not.toHaveBeenCalled();
    expect(roleFindOne).not.toHaveBeenCalled();
  });

  it('superadmin → TODAS las 22 keys, sin tocar la BD', async () => {
    const { action, employeeFindOne } = makeAction({});

    const perms = await action.execute(superadminActor);

    expect(perms).toEqual([...PERMISSION_KEYS]);
    expect(employeeFindOne).not.toHaveBeenCalled();
  });

  it('empleado con rol → permisos del rol (filtrados a keys válidas)', async () => {
    const rolePerms = ['canAccessPOS', 'canAccessExpenses', 'canAccessUnknown'];
    const { action, roleFindOne } = makeAction({
      employee: { id: '50', role_id: '7' },
      role: { id: '7', company_id: '10', permissions: rolePerms as PermissionKey[] },
    });

    const perms = await action.execute(employeeActor);

    // La key fuera del catálogo se filtra.
    expect(perms).toEqual(['canAccessPOS', 'canAccessExpenses']);
    // El rol se buscó filtrando por company del actor.
    expect(roleFindOne).toHaveBeenCalledWith({
      where: { id: '7', company_id: '10' },
    });
  });

  it('empleado SIN rol (role_id null) → LEGACY', async () => {
    const { action, roleFindOne } = makeAction({
      employee: { id: '50', role_id: null },
    });

    const perms = await action.execute(employeeActor);

    expect(perms).toEqual([...LEGACY_EMPLOYEE_PERMISSIONS]);
    // No hay rol que buscar.
    expect(roleFindOne).not.toHaveBeenCalled();
  });

  it('empleado con role_id pero rol inexistente → LEGACY', async () => {
    const { action } = makeAction({
      employee: { id: '50', role_id: '7' },
      role: null,
    });

    const perms = await action.execute(employeeActor);

    expect(perms).toEqual([...LEGACY_EMPLOYEE_PERMISSIONS]);
  });

  it('empleado no hallado en la company del JWT → LEGACY (aislamiento)', async () => {
    const { action, employeeFindOne } = makeAction({ employee: null });

    const perms = await action.execute(employeeActor);

    expect(perms).toEqual([...LEGACY_EMPLOYEE_PERMISSIONS]);
    // La búsqueda del empleado SIEMPRE filtra por user_id + company_id del JWT.
    expect(employeeFindOne).toHaveBeenCalledWith({
      where: { user_id: '50', company_id: '10', is_archived: false },
    });
  });

  it('empleado sin company (caso anómalo) → LEGACY sin tocar la BD', async () => {
    const { action, employeeFindOne } = makeAction({});

    const perms = await action.execute({ ...employeeActor, company_id: null });

    expect(perms).toEqual([...LEGACY_EMPLOYEE_PERMISSIONS]);
    expect(employeeFindOne).not.toHaveBeenCalled();
  });
});
