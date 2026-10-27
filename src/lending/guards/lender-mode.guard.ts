import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { LENDING_TENANT, type LendingTenantPort } from '../ports/lending-tenant.port';

/**
 * Exige que la company del actor sea PRESTAMISTA. Protege todo el contexto de
 * préstamos: fuera de ese tipo de negocio responde 403 para CUALQUIER usuario.
 *
 * El tipo de negocio se consulta por el puerto de tenant (hoy, la tabla
 * `companies` del POS); ante un valor desconocido, se niega.
 */
@Injectable()
export class LenderModeGuard implements CanActivate {
  constructor(@Inject(LENDING_TENANT) private readonly tenant: LendingTenantPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    if (!user || typeof user.company_id !== 'number' || user.company_id <= 0) {
      throw new ForbiddenException('Endpoint no disponible para esta cuenta');
    }
    if (!(await this.tenant.isLender(user.company_id))) {
      throw new ForbiddenException('Este módulo solo está disponible para prestamistas.');
    }
    return true;
  }
}
