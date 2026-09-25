import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type { CreditPaymentConfigDto, UpdateCreditPaymentDto } from '../dto/credit-payment.dto';
import { PG_UNIQUE_VIOLATION } from '../internal/constraint-errors';

/**
 * Set value del flag «habilitar pago a Crédito».
 *
 * El guard de admin (`canAccessSettings`) vive en el controller. Aquí solo se
 * persiste: upsert por (company_id, key) en transacción, con reintento ante
 * unique_violation por una race condition concurrente. Molde de
 * `UpsertShowDailyQuotaBarAction`.
 */
@Injectable()
export class UpsertEnableCreditPaymentAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(dto: UpdateCreditPaymentDto, companyId: number): Promise<CreditPaymentConfigDto> {
    const value = dto.enabled ? 'true' : 'false';

    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(AppSetting, {
        where: {
          company_id: String(companyId),
          key: APP_SETTING_KEYS.ENABLE_CREDIT_PAYMENT,
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
          key: APP_SETTING_KEYS.ENABLE_CREDIT_PAYMENT,
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
              key: APP_SETTING_KEYS.ENABLE_CREDIT_PAYMENT,
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
