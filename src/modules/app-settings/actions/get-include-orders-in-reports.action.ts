import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type { IncludeOrdersInReportsConfigDto } from '../dto/include-orders-in-reports.dto';

/**
 * Lee el flag «incluir pedidos en informes» — espejo de
 * `placepos/src/main/server/services/reportSettings.service.ts →
 * isIncludeOrdersInReportsEnabled`.
 *
 * Default: `false` si la key no existe (comportamiento actual: los pedidos
 * ORDER nunca se cuentan como ingreso).
 */
@Injectable()
export class GetIncludeOrdersInReportsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<IncludeOrdersInReportsConfigDto> {
    const row = await this.dataSource.getRepository(AppSetting).findOne({
      where: {
        company_id: String(companyId),
        key: APP_SETTING_KEYS.INCLUDE_ORDERS_IN_REPORTS,
      },
    });
    return { enabled: row?.value === 'true' };
  }
}
