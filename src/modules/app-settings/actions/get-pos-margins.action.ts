import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type { PosMarginsConfigDto } from '../dto/pos-margins.dto';

/**
 * Lee la configuración de márgenes POS — espejo de
 * `placepos/src/main/server/services/posMargins.service.ts → getPosMarginsConfig`.
 *
 * - `enabled` proviene de la key `pos_margins_enabled` ('true'/'false').
 * - `margins` proviene de la key `pos_margins` (JSON serializado de un array
 *   de números). Si la key no existe o el JSON es inválido, devuelve `[]`
 *   — paridad con PlacePos (`parseMargins`).
 *
 * Multi-tenancy: ambas lookups filtran por `company_id`.
 */
@Injectable()
export class GetPosMarginsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<PosMarginsConfigDto> {
    const repo = this.dataSource.getRepository(AppSetting);
    const [enabledRow, marginsRow] = await Promise.all([
      repo.findOne({
        where: { company_id: String(companyId), key: APP_SETTING_KEYS.POS_MARGINS_ENABLED },
      }),
      repo.findOne({
        where: { company_id: String(companyId), key: APP_SETTING_KEYS.POS_MARGINS },
      }),
    ]);
    return {
      enabled: enabledRow?.value === 'true',
      margins: parseMargins(marginsRow?.value),
    };
  }
}

function parseMargins(raw: string | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    if (!parsed.every((n) => typeof n === 'number')) return [];
    return parsed;
  } catch {
    return [];
  }
}
