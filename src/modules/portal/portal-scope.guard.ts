import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { PORTAL_ROUTE_KEY } from './portal-route.decorator';

/**
 * Guard global de alcance del token.
 *
 * Se registra JUSTO DESPUÉS de `JwtAuthGuard` y ANTES de `SubscriptionGuard`:
 * necesita `request.user`, y un token de portal usado fuera de su sitio tiene
 * que responder 403 (alcance) y no 402 (suscripción) — el motivo real es el
 * alcance.
 *
 * Reglas:
 *   - Token `app` (o ruta sin token) → pasa. Nada cambia para PlacePos/PWA.
 *   - Token `portal` en ruta `@PortalRoute()` → pasa.
 *   - Token `portal` en cualquier otra ruta → 403 `PORTAL_TOKEN_SCOPE`.
 *
 * Fail-closed por construcción: la lista de rutas permitidas es explícita, así
 * que un endpoint nuevo NO queda expuesto al token de portal por olvido.
 */
@Injectable()
export class PortalScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    // Sin user (ruta pública o token ausente) no hay alcance que verificar.
    if (!user || user.scope !== 'portal') {
      return true;
    }

    const isPortalRoute = this.reflector.getAllAndOverride<boolean>(PORTAL_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPortalRoute) {
      return true;
    }

    throw new ForbiddenException({
      message: 'Esta sesión solo permite gestionar la suscripción.',
      payload: { code: 'PORTAL_TOKEN_SCOPE' },
    });
  }
}
