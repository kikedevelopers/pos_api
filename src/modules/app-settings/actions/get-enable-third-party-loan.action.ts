import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type { ThirdPartyLoanConfigDto } from '../dto/third-party-loan.dto';

/**
 * Lee el flag «habilitar Préstamo a Tercero».
 *
 * Default: `false` si la key no existe — la feature viene APAGADA hasta que un
 * admin la active. Es la fuente de verdad que `ConvertOrderToLoanAction`
 * revalida (fail-closed) antes de convertir un pedido en préstamo, al estilo
 * `assertElectronicBillingEnabled`: el backend manda sobre el estado del front.
 */
@Injectable()
export class GetEnableThirdPartyLoanAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<ThirdPartyLoanConfigDto> {
    const row = await this.dataSource.getRepository(AppSetting).findOne({
      where: {
        company_id: String(companyId),
        key: APP_SETTING_KEYS.ENABLE_THIRD_PARTY_LOAN,
      },
    });
    return { enabled: row?.value === 'true' };
  }
}
