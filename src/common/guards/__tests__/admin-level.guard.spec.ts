import { ForbiddenException, type ExecutionContext } from '@nestjs/common';

import { AdminLevelGuard } from '../admin-level.guard';
import { PERMISSION_KEYS } from '@/modules/roles/internal/permission-catalog';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import type { AuthUser } from '@/common/types/jwt-payload.type';

function contextWith(user: AuthUser | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function makeResolver(keys: readonly string[]): ResolveEffectivePermissionsAction {
  return { execute: jest.fn().mockResolvedValue([...keys]) } as unknown as ResolveEffectivePermissionsAction;
}

const OWNER: AuthUser = {
  user_id: 1,
  company_id: 8,
  name: 'A',
  lastname: 'B',
  type: 'owner',
  account: 'user',
  scope: 'app',
};

describe('AdminLevelGuard', () => {
  it('deja pasar a nivel admin (todas las keys)', async () => {
    const guard = new AdminLevelGuard(makeResolver(PERMISSION_KEYS));
    await expect(guard.canActivate(contextWith(OWNER))).resolves.toBe(true);
  });

  it('rechaza a quien no tiene todas las keys (p.ej. Cajero)', async () => {
    const cajero = PERMISSION_KEYS.filter((k) => k !== 'canAccessSettings');
    const guard = new AdminLevelGuard(makeResolver(cajero));
    await expect(
      guard.canActivate(contextWith({ ...OWNER, type: 'employee', account: 'employee' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rechaza si no hay usuario autenticado', async () => {
    const guard = new AdminLevelGuard(makeResolver(PERMISSION_KEYS));
    await expect(guard.canActivate(contextWith(undefined))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
