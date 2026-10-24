import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Request } from 'express';

import { resolvePosMode } from '@/common/pos-mode/pos-mode.util';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { Company } from '@/modules/companies/entities/company.entity';

/**
 * Exige que la company del actor sea PRESTAMISTA (`pos_mode = 'lender'`).
 * Protege los módulos que solo existen en ese modo (planes de préstamo,
 * cartera de préstamos): fuera de él responde 403 para CUALQUIER usuario.
 *
 * Un valor desconocido se normaliza a 'retail' (→ 403): ante la duda, se niega.
 * Gemelo de `RestaurantModeGuard`.
 */
@Injectable()
export class LenderModeGuard implements CanActivate {
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

    if (!company || resolvePosMode(company.pos_mode) !== 'lender') {
      throw new ForbiddenException('Este módulo solo está disponible para prestamistas.');
    }

    return true;
  }
}
