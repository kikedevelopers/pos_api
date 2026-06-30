import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request } from 'express';
import { DataSource } from 'typeorm';

import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';
import { SKIP_ACTIVE_COMPANY_CHECK_KEY } from '@/common/decorators/skip-active-company-check.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

/**
 * Guard global de membresía activa (multi-sucursal gating).
 *
 * Cierra el hueco de un JWT viejo apuntando a una sucursal que fue suspendida o
 * cuya cuenta perdió el permiso de sucursales: rechaza (403) cualquier petición
 * de NEGOCIO cuyo `company_id` (del JWT) sea una sucursal no-activa o sin
 * permiso. El cliente, al recibir el 403 o al leer el perfil, hace switch al
 * principal.
 *
 * Reglas:
 *   - `@Public()` o `@SkipActiveCompanyCheck()` → pasa (login, perfil y todo
 *     `/branches/*` para poder recuperarse).
 *   - Sin `user`, superadmin (`company_id` null) o tokens de empleado
 *     (`account!=='user'`) → pasa.
 *   - Company del JWT que es el PRINCIPAL (`is_branch=false`) → pasa siempre.
 *   - Company del JWT que es SUCURSAL → exige `branches_enabled` y membresía
 *     `is_active`; si no, 403.
 *
 * Una sola query (join companies + users + company_members). Va como APP_GUARD
 * después de `JwtAuthGuard`/`SubscriptionGuard` (necesita `request.user`).
 */
@Injectable()
export class ActiveCompanyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_ACTIVE_COMPANY_CHECK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) {
      return true;
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (
      !user ||
      user.account !== 'user' ||
      user.company_id === null ||
      user.company_id === undefined
    ) {
      return true;
    }

    const rows = await this.dataSource.query<
      Array<{ is_branch: boolean; branches_enabled: boolean; is_active: boolean | null }>
    >(
      `SELECT c.is_branch AS is_branch,
              u.branches_enabled AS branches_enabled,
              cm.is_active AS is_active
       FROM companies c
       LEFT JOIN users u ON u.id = $1
       LEFT JOIN company_members cm ON cm.user_id = $1 AND cm.company_id = $2
       WHERE c.id = $2`,
      [String(user.user_id), String(user.company_id)],
    );

    const row = rows[0];
    // Company inexistente o principal → no es asunto de este guard.
    if (!row || !row.is_branch) {
      return true;
    }
    if (!row.branches_enabled) {
      throw new ForbiddenException(
        'Las sucursales no están habilitadas; vuelve a tu negocio principal.',
      );
    }
    if (!row.is_active) {
      throw new ForbiddenException('Sucursal suspendida; selecciona tu negocio principal.');
    }
    return true;
  }
}
