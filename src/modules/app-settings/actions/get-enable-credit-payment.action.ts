import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import type { CreditPaymentConfigDto } from '../dto/credit-payment.dto';

/**
 * Lee el flag «habilitar pago a Crédito».
 *
 * Default: `true` si la key no existe — el crédito viene VISIBLE por defecto
 * (comportamiento histórico). Los negocios ya registrados no necesitan
 * backfill: al faltar la fila, el valor cae a true.
 */
@Injectable()
export class GetEnableCreditPaymentAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<CreditPaymentConfigDto> {
    const row = await this.dataSource.getRepository(AppSetting).findOne({
      where: {
        company_id: String(companyId),
        key: APP_SETTING_KEYS.ENABLE_CREDIT_PAYMENT,
      },
    });
    // Fila ausente ⇒ true (default). Solo un 'false' explícito apaga el crédito.
    return { enabled: row ? row.value === 'true' : true };
  }
}
