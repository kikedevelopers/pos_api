import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { resolvePosMode } from '@/common/pos-mode/pos-mode.util';
import { Company } from '@/modules/companies/entities/company.entity';

import type { LendingTenantPort } from '../../ports/lending-tenant.port';

/**
 * Tipo de negocio de la company (`companies.pos_mode`). Un valor desconocido
 * se normaliza a retail → no es prestamista: ante la duda, se niega.
 */
@Injectable()
export class PosTenantAdapter implements LendingTenantPort {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async isLender(companyId: number): Promise<boolean> {
    const company = await this.dataSource
      .getRepository(Company)
      .findOne({ where: { id: String(companyId) }, select: { id: true, pos_mode: true } });
    return !!company && resolvePosMode(company.pos_mode) === 'lender';
  }
}
