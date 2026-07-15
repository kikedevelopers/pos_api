import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type {
  ShowAllBaseProductsInPurchasesConfigDto,
  UpdateShowAllBaseProductsInPurchasesDto,
} from '../dto/show-all-base-products-in-purchases.dto';
import { PG_UNIQUE_VIOLATION } from '../internal/constraint-errors';

/**
 * Set value del flag «mostrar todos los productos base en compras» — espejo de
 * `placepos/src/main/server/routes/app-settings.routes.ts →
 * PUT /show-all-base-products-in-purchases`.
 *
 * El gate (`canAccessSettings`: administradores y dueños) vive en el
 * controller. Aquí solo persistimos.
 *
 * Persistencia: upsert por (company_id, key) en transacción. Reintento ante
 * unique_violation por race condition concurrente.
 */
@Injectable()
export class UpsertShowAllBaseProductsInPurchasesAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: UpdateShowAllBaseProductsInPurchasesDto,
    companyId: number,
  ): Promise<ShowAllBaseProductsInPurchasesConfigDto> {
    const value = dto.enabled ? 'true' : 'false';

    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(AppSetting, {
        where: {
          company_id: String(companyId),
          key: APP_SETTING_KEYS.SHOW_ALL_BASE_PRODUCTS_IN_PURCHASES,
        },
      });
      if (existing) {
        await manager.update(
          AppSetting,
          { id: existing.id, company_id: String(companyId) },
          { value },
        );
        return;
      }
      try {
        await manager.insert(AppSetting, {
          company_id: String(companyId),
          key: APP_SETTING_KEYS.SHOW_ALL_BASE_PRODUCTS_IN_PURCHASES,
          value,
        });
      } catch (error) {
        if (
          error instanceof QueryFailedError &&
          (error as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
        ) {
          await manager.update(
            AppSetting,
            {
              company_id: String(companyId),
              key: APP_SETTING_KEYS.SHOW_ALL_BASE_PRODUCTS_IN_PURCHASES,
            },
            { value },
          );
        } else {
          throw error;
        }
      }
    });

    return { enabled: dto.enabled };
  }
}
