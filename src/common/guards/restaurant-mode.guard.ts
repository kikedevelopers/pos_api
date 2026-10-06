import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Request } from 'express';

import { resolvePosMode } from '@/common/pos-mode/pos-mode.util';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { Company } from '@/modules/companies/entities/company.entity';

/**
 * Exige que la company del actor opere en modo RESTAURANTE (`pos_mode =
 * 'restaurant'`). Protege los módulos que solo existen en ese modo (Salones y
 * Mesas): en modo retail, el endpoint responde 403 para CUALQUIER usuario
 * —owner o empleado—, no solo se oculta en la UI.
 *
 * Lee `companies.pos_mode` por el `company_id` del JWT. Un valor desconocido se
 * normaliza a 'retail' (→ 403), de modo que ante la duda el acceso se niega.
 *
 * Se aplica por controller con `@UseGuards(RestaurantModeGuard)`; corre después
 * del `JwtAuthGuard` global, así que `request.user` ya está poblado.
 */
@Injectable()
export class RestaurantModeGuard implements CanActivate {
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

    if (!company || resolvePosMode(company.pos_mode) !== 'restaurant') {
      throw new ForbiddenException('Este módulo solo está disponible en el modo restaurante.');
    }

    return true;
  }
}
