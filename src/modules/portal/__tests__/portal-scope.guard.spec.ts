import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import type { AuthUser, TokenScope } from '@/common/types/jwt-payload.type';

import { PortalScopeGuard } from '../portal-scope.guard';

// ---------------------------------------------------------------------------
// La frontera del token del portal.
//
// El login del portal deja entrar con la suscripción vencida. Sin esta
// frontera, dejar vencer la suscripción sería la manera de conseguir un token
// que abre TODO el API sin pagar: exactamente el bloqueo que se quería aplicar,
// convertido en su propio bypass.
// ---------------------------------------------------------------------------

const buildUser = (scope: TokenScope): AuthUser => ({
  user_id: 42,
  company_id: 7,
  name: 'Test',
  lastname: 'User',
  type: 'owner',
  account: 'user',
  scope,
});

const buildContext = (user: AuthUser | undefined): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as unknown as ExecutionContext;

const buildReflector = (isPortalRoute: boolean | undefined): Reflector =>
  ({ getAllAndOverride: () => isPortalRoute }) as unknown as Reflector;

describe('PortalScopeGuard', () => {
  it('el token del portal pasa en una ruta del portal', () => {
    const guard = new PortalScopeGuard(buildReflector(true));

    expect(guard.canActivate(buildContext(buildUser('portal')))).toBe(true);
  });

  it('el token del portal NO pasa en el resto del API', () => {
    const guard = new PortalScopeGuard(buildReflector(undefined));

    const error = (() => {
      try {
        guard.canActivate(buildContext(buildUser('portal')));
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(ForbiddenException);
    const body = (error as ForbiddenException).getResponse() as { payload: { code: string } };
    expect(body.payload.code).toBe('PORTAL_TOKEN_SCOPE');
  });

  it('el token normal de la app pasa en cualquier ruta', () => {
    const guardBusiness = new PortalScopeGuard(buildReflector(undefined));
    const guardPortal = new PortalScopeGuard(buildReflector(true));

    expect(guardBusiness.canActivate(buildContext(buildUser('app')))).toBe(true);
    expect(guardPortal.canActivate(buildContext(buildUser('app')))).toBe(true);
  });

  it('sin usuario (ruta pública) no hay alcance que revisar', () => {
    const guard = new PortalScopeGuard(buildReflector(undefined));

    expect(guard.canActivate(buildContext(undefined))).toBe(true);
  });

  it('una ruta nueva sin marcar queda cerrada al token del portal, no abierta', () => {
    // La lista de rutas permitidas es explícita a propósito: si mañana se añade
    // un endpoint y nadie se acuerda del decorador, el fallo es "no entra",
    // nunca "entra de más".
    const guard = new PortalScopeGuard(buildReflector(false));

    expect(() => guard.canActivate(buildContext(buildUser('portal')))).toThrow(ForbiddenException);
  });
});
