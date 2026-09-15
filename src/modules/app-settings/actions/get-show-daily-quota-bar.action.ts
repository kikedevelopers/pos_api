import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type { ShowDailyQuotaBarConfigDto } from '../dto/show-daily-quota-bar.dto';

/**
 * Lee el flag «mostrar barra de cuota diaria en el POS».
 *
 * Default: `false` si la key no existe — la barra viene oculta hasta que un
 * admin la active. Los negocios ya registrados no necesitan backfill: al faltar
 * la row, el valor cae a false.
 */
@Injectable()
export class GetShowDailyQuotaBarAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<ShowDailyQuotaBarConfigDto> {
    const row = await this.dataSource.getRepository(AppSetting).findOne({
      where: {
        company_id: String(companyId),
        key: APP_SETTING_KEYS.SHOW_DAILY_QUOTA_BAR,
      },
    });
    return { enabled: row?.value === 'true' };
  }
}
