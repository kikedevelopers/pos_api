import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ROLES_KEY } from '@/common/decorators/roles.decorator';
import type { AuthUser, UserType } from '@/common/types/jwt-payload.type';

/**
 * Guard que valida `request.user.type` contra los roles permitidos por el
 * decorador `@Roles(...)`.
 *
 * Si el endpoint no tiene `@Roles(...)`, este guard deja pasar (asumiendo
 * que `JwtAuthGuard` ya autenticó). Si tiene, exige match exacto.
 *
 * Debe registrarse DESPUÉS de `JwtAuthGuard` en `APP_GUARD` para que
 * `request.user` ya esté poblado al evaluar.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowedRoles = this.reflector.getAllAndOverride<UserType[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Sin @Roles → cualquier autenticado pasa.
    if (!allowedRoles || allowedRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    if (!user) {
      // Llegamos aquí solo si alguien usa @Roles en un endpoint @Public — bug de configuración.
      throw new ForbiddenException('Usuario sin permisos para esta acción');
    }

    if (!allowedRoles.includes(user.type)) {
      throw new ForbiddenException('Usuario sin permisos para esta acción');
    }

    return true;
  }
}
