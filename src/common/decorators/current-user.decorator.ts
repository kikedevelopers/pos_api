import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthUser } from '@/common/types/jwt-payload.type';

/**
 * Inyecta el `AuthUser` que `JwtStrategy.validate` coloca en `request.user`.
 *
 * Si el endpoint está marcado con `@Public()` y no hay token, `request.user`
 * será `undefined` — no usar `@CurrentUser()` en endpoints públicos.
 *
 * Uso:
 *   @Get('me')
 *   me(@CurrentUser() user: AuthUser) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    // Si llega aquí sin user, es un bug de configuración (decorador en endpoint público sin guard).
    // Devolvemos el objeto tal cual; el caller verá `undefined` y fallará explícitamente.
    return request.user as AuthUser;
  },
);
