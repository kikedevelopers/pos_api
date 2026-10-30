import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { SalesAgentAccessService } from './sales-agent-access.service';

/**
 * Bloquea los endpoints del asistente de ventas (configuración, ajustes, ficha
 * de productos, relay de WhatsApp) cuando el negocio del usuario no lo tiene
 * habilitado: 403 SALES_AGENT_NOT_ENABLED.
 */
@Injectable()
export class SalesAgentEnabledGuard implements CanActivate {
  constructor(private readonly access: SalesAgentAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const companyId = request.user?.company_id;
    if (typeof companyId !== 'number') {
      throw new ForbiddenException('Autenticación requerida.');
    }
    await this.access.assertEnabled(companyId);
    return true;
  }
}
