import { UnprocessableEntityException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import { DeleteRoleAction } from '../actions/delete-role.action';
import type { Role } from '../entities/role.entity';
import { ROLE_NOT_EDITABLE } from '../internal/role-constraint-errors';

/**
 * Tests unitarios de `DeleteRoleAction` — FASE 5 (editabilidad de roles).
 *
 * Reglas (en orden de evaluación):
 *   1. Rol inmutable (`is_editable = false`, p.ej. 'Administrador') → 422
 *      (code ROLE_NOT_EDITABLE), sin DELETE.
 *   2. Rol de sistema editable (p.ej. 'Cajero') → 422 por `is_system`, sin
 *      DELETE.
 *   3. Rol custom (no-sistema, editable) → ejecuta el DELETE.
 */
function makeAction(role: Partial<Role>): {
  action: DeleteRoleAction;
  manager: { findOne: jest.Mock; delete: jest.Mock };
} {
  const manager = {
    findOne: jest.fn().mockResolvedValue(role),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => unknown) =>
      cb(manager as unknown as EntityManager),
    ),
  } as unknown as DataSource;
  return { action: new DeleteRoleAction(dataSource), manager };
}

describe('DeleteRoleAction (editabilidad)', () => {
  it('rechaza con 422 (ROLE_NOT_EDITABLE) borrar un rol inmutable, sin DELETE', async () => {
    const admin: Partial<Role> = {
      id: '1',
      company_id: '10',
      name: 'Administrador',
      is_system: true,
      is_editable: false,
    };
    const { action, manager } = makeAction(admin);

    try {
      await action.execute(1, 10);
      fail('debió lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      const res = (err as UnprocessableEntityException).getResponse() as {
        payload?: { code?: string };
      };
      expect(res.payload?.code).toBe(ROLE_NOT_EDITABLE);
    }
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('rechaza con 422 borrar un rol de sistema editable (Cajero), sin DELETE', async () => {
    const cajero: Partial<Role> = {
      id: '2',
      company_id: '10',
      name: 'Cajero',
      is_system: true,
      is_editable: true,
    };
    const { action, manager } = makeAction(cajero);

    await expect(action.execute(2, 10)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('permite borrar un rol custom (no-sistema, editable) y ejecuta el DELETE', async () => {
    const custom: Partial<Role> = {
      id: '3',
      company_id: '10',
      name: 'Supervisor',
      is_system: false,
      is_editable: true,
    };
    const { action, manager } = makeAction(custom);

    await expect(action.execute(3, 10)).resolves.toBeUndefined();
    expect(manager.delete).toHaveBeenCalledTimes(1);
  });
});
