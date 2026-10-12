import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Request } from 'express';

import { resolvePosMode } from '@/common/pos-mode/pos-mode.util';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { Company } from '@/modules/companies/entities/company.entity';

/**
 * Inverso de `RestaurantModeGuard`: exige que la company opere en modo RETAIL
 * (`pos_mode = 'retail'`). Protege los flujos exclusivos de retail —p. ej.
 * "Compartir pedido para alistar"— que no aplican en restaurante (donde el
 * alistado se maneja por Comandas). En modo restaurante responde 403 para
 * cualquier usuario, no solo se oculta en la UI.
 *
 * Un `pos_mode` desconocido se normaliza a 'retail' (→ PASA): retail es el modo
 * por defecto, así que ante la duda el flujo retail queda disponible.
 */
@Injectable()
export class RetailModeGuard implements CanActivate {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    if (!user || typeof user.company_id !== 'number' || user.company_id <= 0) {
      throw new ForbiddenException('Endpoint no disponible para esta cuenta');
    }

    const company = await this.dataSource
      .getRepository(Company)
      .findOne({ where: { id: String(user.company_id) }, select: { id: true, pos_mode: true } });

    if (company && resolvePosMode(company.pos_mode) === 'restaurant') {
      throw new ForbiddenException(
        'Compartir un pedido no está disponible en el modo restaurante (usa Comandas).',
      );
    }

    return true;
  }
}
