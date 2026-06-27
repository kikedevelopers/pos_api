import { UnprocessableEntityException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import { UpdateRoleAction } from '../actions/update-role.action';
import type { UpdateRoleDto } from '../dto/update-role.dto';
import type { Role } from '../entities/role.entity';
import { ROLE_NOT_EDITABLE } from '../internal/role-constraint-errors';

/**
 * Tests unitarios de `UpdateRoleAction` — FASE 5 (editabilidad de roles).
 *
 * Verifican la NUEVA regla:
 *   - Editar un rol inmutable (`is_editable = false`, p.ej. 'Administrador') →
 *     422 (code ROLE_NOT_EDITABLE), sin ejecutar el UPDATE. Owner incluido.
 *   - Editar un rol editable (p.ej. 'Cajero', incluso siendo de sistema) →
 *     ejecuta el UPDATE con el patch normalizado.
 *
 * El `DataSource` se mockea: `transaction(cb)` corre el callback con un
 * `EntityManager` falso. `findRoleInCompany` se satisface vía `manager.findOne`;
 * el conteo de empleados vía `manager.query`.
 */
function makeAction(role: Partial<Role>): {
  action: UpdateRoleAction;
  manager: { findOne: jest.Mock; update: jest.Mock; query: jest.Mock };
} {
  const manager = {
    findOne: jest.fn().mockResolvedValue(role),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    query: jest.fn().mockResolvedValue([{ n: 0 }]),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => unknown) =>
      cb(manager as unknown as EntityManager),
    ),
  } as unknown as DataSource;
  return { action: new UpdateRoleAction(dataSource), manager };
}

describe('UpdateRoleAction (editabilidad)', () => {
  it('rechaza con 422 (ROLE_NOT_EDITABLE) editar un rol inmutable, sin UPDATE', async () => {
    const admin: Partial<Role> = {
      id: '1',
      company_id: '10',
      name: 'Administrador',
      is_system: true,
      is_editable: false,
    };
    const { action, manager } = makeAction(admin);
    const dto = { name: 'Hackeado' } as UpdateRoleDto;

    await expect(action.execute(1, dto, 10)).rejects.toBeInstanceOf(UnprocessableEntityException);

    // El UPDATE NUNCA se ejecuta.
    expect(manager.update).not.toHaveBeenCalled();

    // El code programático es el esperado por el front.
    try {
      await action.execute(1, dto, 10);
      fail('debió lanzar');
    } catch (err) {
      const res = (err as UnprocessableEntityException).getResponse() as {
        payload?: { code?: string };
      };
      expect(res.payload?.code).toBe(ROLE_NOT_EDITABLE);
    }
  });

  it('permite editar un rol editable (Cajero, de sistema) y ejecuta el UPDATE', async () => {
    const cajero: Partial<Role> = {
      id: '2',
      company_id: '10',
      name: 'Cajero',
      is_system: true,
      is_editable: true,
      permissions: ['canAccessPOS'],
      created_at: new Date(),
      updated_at: new Date(),
    };
    const { action, manager } = makeAction(cajero);
    const dto = { permissions: ['canAccessPOS', 'canAccessPOS', 'canAccessExpenses'] } as UpdateRoleDto;

    const result = await action.execute(2, dto, 10);

    expect(manager.update).toHaveBeenCalledTimes(1);
    // El patch dedup-normaliza los permisos.
    const patchArg = manager.update.mock.calls[0][2] as { permissions: string[] };
    expect(patchArg.permissions).toEqual(['canAccessPOS', 'canAccessExpenses']);
    expect(result.role).toBe(cajero);
    expect(result.employeeCount).toBe(0);
  });
});
