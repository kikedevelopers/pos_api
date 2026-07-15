import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { REQUIRE_PERMISSION_KEY } from '@/common/decorators/require-permission.decorator';
import { ROLES_KEY } from '@/common/decorators/roles.decorator';
import type { AuthUser, UserType } from '@/common/types/jwt-payload.type';

import { RolesGuard } from '../roles.guard';

/**
 * Tests unitarios de `RolesGuard`, con foco en la EXCEPCIÓN RBAC: un empleado
 * cuyo tipo no está en `@Roles` puede pasar si el endpoint declara
 * `@RequirePermission` (la decisión real la toma luego el `PermissionsGuard`).
 *
 * `Reflector` se mockea para devolver los roles permitidos (ROLES_KEY) y el
 * permiso requerido (REQUIRE_PERMISSION_KEY) según la metadata simulada.
 */
describe('RolesGuard', () => {
  const buildUser = (type: UserType): AuthUser => ({
    user_id: 42,
    company_id: 7,
    name: 'Test',
    lastname: 'User',
    type,
    account: type === 'employee' ? 'employee' : 'user',
  });

  const buildContext = (user: AuthUser | undefined): ExecutionContext => {
    const request = { user };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  };

  // Reflector que distingue por key: roles para ROLES_KEY, permiso para
  // REQUIRE_PERMISSION_KEY.
  const buildReflector = (
    roles: UserType[] | undefined,
    permission: string | undefined,
  ): Reflector =>
    ({
      getAllAndOverride: jest.fn((key: string) =>
        key === ROLES_KEY ? roles : key === REQUIRE_PERMISSION_KEY ? permission : undefined,
      ),
    }) as unknown as Reflector;

  it('sin @Roles → cualquier autenticado pasa', () => {
    const guard = new RolesGuard(buildReflector(undefined, undefined));
    expect(guard.canActivate(buildContext(buildUser('employee')))).toBe(true);
  });

  it('tipo permitido por @Roles → pasa', () => {
    const guard = new RolesGuard(buildReflector(['owner', 'manager'], undefined));
    expect(guard.canActivate(buildContext(buildUser('owner')))).toBe(true);
  });

  it('sin request.user (config errónea) → 403', () => {
    const guard = new RolesGuard(buildReflector(['owner'], undefined));
    expect(() => guard.canActivate(buildContext(undefined))).toThrow(ForbiddenException);
  });

  it('empleado fuera de @Roles y SIN @RequirePermission → 403', () => {
    const guard = new RolesGuard(buildReflector(['owner', 'manager'], undefined));
    expect(() => guard.canActivate(buildContext(buildUser('employee')))).toThrow(
      ForbiddenException,
    );
  });

  it('empleado fuera de @Roles pero CON @RequirePermission → pasa (delega al PermissionsGuard)', () => {
    const guard = new RolesGuard(buildReflector(['owner', 'manager'], 'canAccessDashboard'));
    expect(guard.canActivate(buildContext(buildUser('employee')))).toBe(true);
  });

  it('manager fuera de @Roles aun CON @RequirePermission → 403 (la delegación es solo para employee)', () => {
    const guard = new RolesGuard(buildReflector(['owner'], 'canAccessDashboard'));
    expect(() => guard.canActivate(buildContext(buildUser('manager')))).toThrow(ForbiddenException);
  });
});
