import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type { ShowAllBaseProductsInPurchasesConfigDto } from '../dto/show-all-base-products-in-purchases.dto';

/**
 * Lee el flag «mostrar todos los productos base en compras» — espejo de
 * `placepos/src/main/server/services/purchaseSettings.service.ts →
 * isShowAllBaseProductsInPurchasesEnabled`.
 *
 * Default: `false` si la key no existe (comportamiento actual: el buscador de
 * compras solo lista los productos con `is_purchasable = true`).
 */
@Injectable()
export class GetShowAllBaseProductsInPurchasesAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<ShowAllBaseProductsInPurchasesConfigDto> {
    const row = await this.dataSource.getRepository(AppSetting).findOne({
      where: {
        company_id: String(companyId),
        key: APP_SETTING_KEYS.SHOW_ALL_BASE_PRODUCTS_IN_PURCHASES,
      },
    });
    return { enabled: row?.value === 'true' };
  }
}
