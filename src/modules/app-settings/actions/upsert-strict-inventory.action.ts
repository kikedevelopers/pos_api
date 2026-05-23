import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type { StrictInventoryConfigDto, UpdateStrictInventoryDto } from '../dto/strict-inventory.dto';
import { PG_UNIQUE_VIOLATION } from '../internal/constraint-errors';

/**
 * Set value del flag global de control estricto de inventario — espejo de
 * `placepos/src/main/server/routes/app-settings.routes.ts → PUT /strict-inventory`.
 *
 * El guard de rol (`owner` | `superadmin`) vive en el controller (paridad
 * con PlacePos). Aquí solo persistimos.
 *
 * Persistencia: upsert por (company_id, key) en transacción. Reintento ante
 * unique_violation por race condition concurrente.
 */
@Injectable()
export class UpsertStrictInventoryAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: UpdateStrictInventoryDto,
    companyId: number,
  ): Promise<StrictInventoryConfigDto> {
    const value = dto.enabled ? 'true' : 'false';

    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(AppSetting, {
        where: {
          company_id: String(companyId),
          key: APP_SETTING_KEYS.STRICT_INVENTORY_CONTROL,
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
          key: APP_SETTING_KEYS.STRICT_INVENTORY_CONTROL,
          value,
        });
      } catch (error) {
        if (
          error instanceof QueryFailedError &&
          (error as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
        ) {
          await manager.update(
            AppSetting,
            { company_id: String(companyId), key: APP_SETTING_KEYS.STRICT_INVENTORY_CONTROL },
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
