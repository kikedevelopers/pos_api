import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type {
  ShowDailyQuotaBarConfigDto,
  UpdateShowDailyQuotaBarDto,
} from '../dto/show-daily-quota-bar.dto';
import { PG_UNIQUE_VIOLATION } from '../internal/constraint-errors';

/**
 * Set value del flag «mostrar barra de cuota diaria en el POS».
 *
 * El guard de admin (`canAccessSettings`) vive en el controller. Aquí solo se
 * persiste: upsert por (company_id, key) en transacción, con reintento ante
 * unique_violation por una race condition concurrente.
 */
@Injectable()
export class UpsertShowDailyQuotaBarAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: UpdateShowDailyQuotaBarDto,
    companyId: number,
  ): Promise<ShowDailyQuotaBarConfigDto> {
    const value = dto.enabled ? 'true' : 'false';

    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(AppSetting, {
        where: {
          company_id: String(companyId),
          key: APP_SETTING_KEYS.SHOW_DAILY_QUOTA_BAR,
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
          key: APP_SETTING_KEYS.SHOW_DAILY_QUOTA_BAR,
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
              key: APP_SETTING_KEYS.SHOW_DAILY_QUOTA_BAR,
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
