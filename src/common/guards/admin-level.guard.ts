import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import { PERMISSION_KEYS } from '@/modules/roles/internal/permission-catalog';

import type { AuthUser } from '@/common/types/jwt-payload.type';

/**
 * Permite el paso SOLO a NIVEL ADMIN: `owner`/`superadmin` (que reciben todas
 * las `PERMISSION_KEYS`), o un empleado cuyo rol tiene TODAS las keys del
 * catálogo (= rol de fábrica "Administrador"). Un Cajero/Vendedor NO pasa,
 * aunque tenga alguna key suelta (p. ej. `canAccessDailyClosureReport`).
 *
 * Corre DESPUÉS del `JwtAuthGuard` global (que cuelga `request.user`). Para
 * usarlo: `@UseGuards(AdminLevelGuard)` y que el módulo del controller importe
 * `RolesModule` (provee `ResolveEffectivePermissionsAction`).
 */
@Injectable()
export class AdminLevelGuard implements CanActivate {
  constructor(private readonly resolvePermissions: ResolveEffectivePermissionsAction) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Autenticación requerida.');
    }

    const perms = await this.resolvePermissions.execute(user);
    const permSet = new Set<string>(perms);
    const isAdminLevel = PERMISSION_KEYS.every((key) => permSet.has(key));
    if (!isAdminLevel) {
      throw new ForbiddenException('Solo el administrador puede acceder a esta sección.');
    }
    return true;
  }
}
