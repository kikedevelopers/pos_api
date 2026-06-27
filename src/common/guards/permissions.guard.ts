import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { REQUIRE_PERMISSION_KEY } from '@/common/decorators/require-permission.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import type { PermissionKey } from '@/modules/roles/internal/permission-catalog';

/**
 * Guard global de enforcement de permisos de módulo (FASE 4).
 *
 * Lee la metadata de `@RequirePermission(key)` (handler con prioridad sobre la
 * clase). Comportamiento:
 *
 *   1. Sin `@RequirePermission` → pasa de inmediato SIN tocar la BD. Esto cubre
 *      la inmensa mayoría de endpoints (POS, lecturas compartidas, etc.) con
 *      coste cero.
 *   2. Con `@RequirePermission`:
 *        - `owner` / `superadmin` → pasan sin consultar la BD (acceso total).
 *        - resto (empleado) → resuelve sus permisos efectivos con
 *          `ResolveEffectivePermissionsAction` usando el actor/company del JWT;
 *          si el permiso requerido NO está → `403`.
 *
 * Se registra como `APP_GUARD` DESPUÉS de `JwtAuthGuard` (para que
 * `request.user` esté poblado) y de `RolesGuard` (el gating grueso por
 * `UserType` corre primero; este guard refina por permiso granular).
 *
 * La única consulta a BD ocurre cuando el endpoint está decorado Y el actor es
 * un empleado, así que el overhead global es nulo.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolvePermissions: ResolveEffectivePermissionsAction,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionKey | undefined>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Endpoint sin protección de permiso → no hacemos nada.
    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    // Llegamos aquí sin user solo si alguien decora un endpoint @Public — bug
    // de configuración. Por seguridad, denegamos.
    if (!user) {
      throw new ForbiddenException('Usuario sin permisos para esta acción');
    }

    // owner/superadmin: acceso total, sin tocar la BD.
    if (user.type === 'owner' || user.type === 'superadmin') {
      return true;
    }

    const effective = await this.resolvePermissions.execute({
      type: user.type,
      account: user.account,
      user_id: user.user_id,
      company_id: user.company_id,
    });

    if (!effective.includes(required)) {
      throw new ForbiddenException('No tienes permiso para acceder a este módulo');
    }

    return true;
  }
}
