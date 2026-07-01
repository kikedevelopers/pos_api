import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { REQUIRE_PERMISSION_KEY } from '@/common/decorators/require-permission.decorator';
import { ROLES_KEY } from '@/common/decorators/roles.decorator';
import type { AuthUser, UserType } from '@/common/types/jwt-payload.type';
import type { PermissionKey } from '@/modules/roles/internal/permission-catalog';

/**
 * Guard que valida `request.user.type` contra los roles permitidos por el
 * decorador `@Roles(...)`.
 *
 * Si el endpoint no tiene `@Roles(...)`, este guard deja pasar (asumiendo
 * que `JwtAuthGuard` ya autenticó). Si tiene, exige match exacto.
 *
 * --------------------------------------------------------------------------
 * Excepción RBAC (empleados con rol personalizado)
 * --------------------------------------------------------------------------
 *
 * El gating legacy por `@Roles('owner','manager')` excluiría a TODO empleado
 * (`type === 'employee'`) de los módulos de datos, incluso a un empleado con rol
 * "Administrador" (que concede todas las keys). Para que el RBAC mande de verdad:
 * cuando el actor es `employee` y su tipo NO está en `@Roles`, pero el endpoint
 * DECLARA un permiso del catálogo con `@RequirePermission(...)`, dejamos pasar y
 * delegamos la decisión al `PermissionsGuard` (que corre después y valida que el
 * rol del empleado tenga esa key; si no la tiene → 403 allí).
 *
 * Así: owner/superadmin pasan por tipo (acceso total); un empleado entra solo a
 * los módulos cuyo permiso posee su rol. Los endpoints SIN `@RequirePermission`
 * (gestión de cuenta, superadmin, suscripción, etc.) siguen cerrados a empleados
 * por `@Roles`, como antes.
 *
 * Debe registrarse DESPUÉS de `JwtAuthGuard` y ANTES de `PermissionsGuard` en
 * `APP_GUARD` para que `request.user` esté poblado y el permiso se valide después.
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

    if (allowedRoles.includes(user.type)) {
      return true;
    }

    // Excepción RBAC: el empleado cuyo tipo no está en @Roles puede entrar si el
    // endpoint declara un permiso del catálogo — el PermissionsGuard validará que
    // su rol tenga la key. Sin @RequirePermission, sigue bloqueado.
    if (user.type === 'employee') {
      const requiredPermission = this.reflector.getAllAndOverride<PermissionKey | undefined>(
        REQUIRE_PERMISSION_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (requiredPermission) {
        return true;
      }
    }

    throw new ForbiddenException('Usuario sin permisos para esta acción');
  }
}
