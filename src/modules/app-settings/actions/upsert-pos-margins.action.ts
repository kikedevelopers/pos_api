import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type { PosMarginsConfigDto, UpdatePosMarginsDto } from '../dto/pos-margins.dto';
import { PG_UNIQUE_VIOLATION } from '../internal/constraint-errors';

/**
 * Upsert atómico de los márgenes POS — espejo de
 * `placepos/src/main/server/routes/app-settings.routes.ts → PUT /pos-margins`.
 *
 * Reglas de negocio (espejo del `superRefine` zod de PlacePos):
 *   - Si `enabled=true`, `margins.length >= 1`.
 *   - Los márgenes deben ir en orden ascendente estricto.
 *
 * Persistencia: 2 upserts en UNA transacción para que el lector vea ambas
 * keys o ninguna. Cada upsert respeta `UNIQUE(company_id, key)` y reintenta
 * como UPDATE ante 23505 por race condition.
 */
@Injectable()
export class UpsertPosMarginsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(dto: UpdatePosMarginsDto, companyId: number): Promise<PosMarginsConfigDto> {
    if (dto.enabled && dto.margins.length < 1) {
      throw new BadRequestException(
        'Debe definirse al menos 1 margen cuando está habilitado',
      );
    }
    for (let i = 1; i < dto.margins.length; i++) {
      if (dto.margins[i] <= dto.margins[i - 1]) {
        throw new BadRequestException(
          'Los márgenes deben ir en orden ascendente estricto',
        );
      }
    }

    const enabledValue = dto.enabled ? 'true' : 'false';
    const marginsValue = JSON.stringify(dto.margins);

    await this.dataSource.transaction(async (manager) => {
      await upsertKey(manager, companyId, APP_SETTING_KEYS.POS_MARGINS_ENABLED, enabledValue);
      await upsertKey(manager, companyId, APP_SETTING_KEYS.POS_MARGINS, marginsValue);
    });

    return { enabled: dto.enabled, margins: dto.margins };
  }
}

async function upsertKey(
  manager: import('typeorm').EntityManager,
  companyId: number,
  key: string,
  value: string,
): Promise<void> {
  const existing = await manager.findOne(AppSetting, {
    where: { company_id: String(companyId), key },
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
      key,
      value,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      await manager.update(AppSetting, { company_id: String(companyId), key }, { value });
    } else {
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const pgError = error as QueryFailedError & { code?: string };
  return pgError.code === PG_UNIQUE_VIOLATION;
}
