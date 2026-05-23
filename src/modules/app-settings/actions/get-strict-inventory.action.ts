import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type { StrictInventoryConfigDto } from '../dto/strict-inventory.dto';

/**
 * Lee el flag global de control estricto de inventario — espejo de
 * `placepos/src/main/server/services/inventorySettings.service.ts →
 * isStrictInventoryEnabled`.
 *
 * Default: `false` si la key no existe (la mayoría de comercios no llevan
 * inventario y prefieren que la venta nunca se bloquee).
 */
@Injectable()
export class GetStrictInventoryAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<StrictInventoryConfigDto> {
    const row = await this.dataSource.getRepository(AppSetting).findOne({
      where: {
        company_id: String(companyId),
        key: APP_SETTING_KEYS.STRICT_INVENTORY_CONTROL,
      },
    });
    return { enabled: row?.value === 'true' };
  }
}
