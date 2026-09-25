import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type {
  ThirdPartyLoanConfigDto,
  UpdateThirdPartyLoanDto,
} from '../dto/third-party-loan.dto';
import { PG_UNIQUE_VIOLATION } from '../internal/constraint-errors';

/**
 * Set value del flag «habilitar Préstamo a Tercero».
 *
 * El guard de admin (`canAccessSettings`) vive en el controller. Aquí solo se
 * persiste: upsert por (company_id, key) en transacción, con reintento ante
 * unique_violation por una race condition concurrente. Molde de
 * `UpsertShowDailyQuotaBarAction`.
 */
@Injectable()
export class UpsertEnableThirdPartyLoanAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: UpdateThirdPartyLoanDto,
    companyId: number,
  ): Promise<ThirdPartyLoanConfigDto> {
    const value = dto.enabled ? 'true' : 'false';

    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(AppSetting, {
        where: {
          company_id: String(companyId),
          key: APP_SETTING_KEYS.ENABLE_THIRD_PARTY_LOAN,
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
          key: APP_SETTING_KEYS.ENABLE_THIRD_PARTY_LOAN,
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
              key: APP_SETTING_KEYS.ENABLE_THIRD_PARTY_LOAN,
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
