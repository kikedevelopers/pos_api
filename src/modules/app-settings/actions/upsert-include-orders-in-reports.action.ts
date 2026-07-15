import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type {
  IncludeOrdersInReportsConfigDto,
  UpdateIncludeOrdersInReportsDto,
} from '../dto/include-orders-in-reports.dto';
import { PG_UNIQUE_VIOLATION } from '../internal/constraint-errors';

/**
 * Set value del flag «incluir pedidos en informes» — espejo de
 * `placepos/src/main/server/routes/app-settings.routes.ts →
 * PUT /include-orders-in-reports`.
 *
 * El guard de rol (`owner` | `superadmin`) vive en el controller (paridad con
 * PlacePos / `strict-inventory`). Aquí solo persistimos.
 *
 * Persistencia: upsert por (company_id, key) en transacción. Reintento ante
 * unique_violation por race condition concurrente.
 */
@Injectable()
export class UpsertIncludeOrdersInReportsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: UpdateIncludeOrdersInReportsDto,
    companyId: number,
  ): Promise<IncludeOrdersInReportsConfigDto> {
    const value = dto.enabled ? 'true' : 'false';

    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(AppSetting, {
        where: {
          company_id: String(companyId),
          key: APP_SETTING_KEYS.INCLUDE_ORDERS_IN_REPORTS,
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
          key: APP_SETTING_KEYS.INCLUDE_ORDERS_IN_REPORTS,
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
              key: APP_SETTING_KEYS.INCLUDE_ORDERS_IN_REPORTS,
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
