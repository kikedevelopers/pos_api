import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import type { AuthUser, UserType } from '@/common/types/jwt-payload.type';
import type {
  PermissionActor,
  ResolveEffectivePermissionsAction,
} from '@/modules/roles/actions/resolve-effective-permissions.action';
import type { PermissionKey } from '@/modules/roles/internal/permission-catalog';

import { PermissionsGuard } from '../permissions.guard';

/**
 * Tests unitarios de `PermissionsGuard` (FASE 4 — enforcement de permisos).
 *
 * Cubre la matriz del brief:
 *   - Endpoint SIN `@RequirePermission` → pasa sin tocar la BD.
 *   - Endpoint CON metadata + actor `owner`/`superadmin` → pasa sin tocar la BD.
 *   - Empleado CON la key (el resolver la incluye) → pasa.
 *   - Empleado SIN la key → `403 ForbiddenException`.
 *   - Sin `request.user` (config errónea) → `403`.
 *
 * `Reflector` y `ResolveEffectivePermissionsAction` se mockean; el segundo
 * registra si fue invocado para verificar el "cero overhead" en los caminos
 * que no deben consultar la BD.
 */
describe('PermissionsGuard', () => {
  const buildUser = (type: UserType, account: AuthUser['account'] = 'employee'): AuthUser => ({
    user_id: 42,
    company_id: 7,
    name: 'Test',
    lastname: 'User',
    type,
    account,
    scope: 'app',
  });

  const buildContext = (user: AuthUser | undefined): ExecutionContext => {
    const request = { user };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  };

  const buildReflector = (required: PermissionKey | undefined): Reflector =>
    ({ getAllAndOverride: jest.fn().mockReturnValue(required) }) as unknown as Reflector;

  const buildResolver = (
    perms: PermissionKey[],
  ): { action: ResolveEffectivePermissionsAction; execute: jest.Mock } => {
    const execute = jest.fn<Promise<PermissionKey[]>, [PermissionActor]>().mockResolvedValue(perms);
    return { action: { execute } as unknown as ResolveEffectivePermissionsAction, execute };
  };

  it('sin @RequirePermission → pasa sin resolver permisos', async () => {
    const { action, execute } = buildResolver([]);
    const guard = new PermissionsGuard(buildReflector(undefined), action);

    await expect(guard.canActivate(buildContext(buildUser('employee')))).resolves.toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('con metadata + owner → pasa sin tocar la BD', async () => {
    const { action, execute } = buildResolver([]);
    const guard = new PermissionsGuard(buildReflector('canAccessBanks'), action);

    await expect(guard.canActivate(buildContext(buildUser('owner', 'user')))).resolves.toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('con metadata + superadmin → pasa sin tocar la BD', async () => {
    const { action, execute } = buildResolver([]);
    const guard = new PermissionsGuard(buildReflector('canAccessBanks'), action);

    await expect(guard.canActivate(buildContext(buildUser('superadmin', 'user')))).resolves.toBe(
      true,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('empleado CON la key requerida → pasa', async () => {
    const { action, execute } = buildResolver(['canAccessPOS', 'canAccessSalesReport']);
    const guard = new PermissionsGuard(buildReflector('canAccessSalesReport'), action);

    await expect(guard.canActivate(buildContext(buildUser('employee')))).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith({
      type: 'employee',
      account: 'employee',
      user_id: 42,
      company_id: 7,
    });
  });

  it('empleado SIN la key requerida → 403', async () => {
    const { action } = buildResolver(['canAccessPOS', 'canAccessCustomers']);
    const guard = new PermissionsGuard(buildReflector('canAccessBanks'), action);

    await expect(guard.canActivate(buildContext(buildUser('employee')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('con metadata pero sin request.user (endpoint @Public mal configurado) → 403', async () => {
    const { action, execute } = buildResolver([]);
    const guard = new PermissionsGuard(buildReflector('canAccessBanks'), action);

    await expect(guard.canActivate(buildContext(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
