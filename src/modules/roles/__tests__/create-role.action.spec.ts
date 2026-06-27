import type { DataSource, EntityManager } from 'typeorm';

import { CreateRoleAction } from '../actions/create-role.action';
import type { CreateRoleDto } from '../dto/create-role.dto';
import type { Role } from '../entities/role.entity';

/**
 * Tests unitarios de `CreateRoleAction` — FASE 5.
 *
 * Verifican que un rol creado vía API SIEMPRE nace:
 *   - `is_system = false` (no se crean roles de fábrica vía API),
 *   - `is_editable = true` (no se crean roles inmutables vía API),
 *   - con `company_id` del actor (nunca del DTO) y permisos deduplicados.
 */
function makeAction(): {
  action: CreateRoleAction;
  manager: { create: jest.Mock; save: jest.Mock };
} {
  const manager = {
    create: jest.fn((_entity: unknown, data: Partial<Role>) => ({ id: '99', ...data })),
    save: jest.fn((_entity: unknown, role: Role) => Promise.resolve(role)),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => unknown) =>
      cb(manager as unknown as EntityManager),
    ),
  } as unknown as DataSource;
  return { action: new CreateRoleAction(dataSource), manager };
}

describe('CreateRoleAction', () => {
  it('crea un rol con is_system=false e is_editable=true y company del actor', async () => {
    const { action, manager } = makeAction();
    const dto = {
      name: '  Supervisor  ',
      permissions: ['canAccessPOS', 'canAccessPOS', 'canAccessExpenses'],
    } as CreateRoleDto;

    const role = await action.execute(dto, 10);

    expect(manager.create).toHaveBeenCalledTimes(1);
    const createData = manager.create.mock.calls[0][1] as Partial<Role>;
    expect(createData.company_id).toBe('10');
    expect(createData.is_system).toBe(false);
    expect(createData.is_editable).toBe(true);
    expect(createData.name).toBe('Supervisor');
    expect(createData.permissions).toEqual(['canAccessPOS', 'canAccessExpenses']);

    // El resultado persistido conserva la editabilidad.
    expect(role.is_editable).toBe(true);
    expect(role.is_system).toBe(false);
  });
});
