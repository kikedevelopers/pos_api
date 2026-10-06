import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { AlertConfig } from '@/modules/alert-configs/entities/alert-config.entity';
import { User, UserType } from '@/modules/users/entities/user.entity';

import { EMAIL_ALERT_TYPES, type EmailAlertType } from '../constants';

export interface EmailAlertSettingItem {
  type: EmailAlertType;
  enabled: boolean;
}

export interface EmailAlertsSettings {
  /** Correo del OWNER: a dónde llegan TODAS las alertas por correo. */
  recipientEmail: string | null;
  alerts: EmailAlertSettingItem[];
}

/**
 * Settings del tab "Alertas": el correo del owner (destino de las alertas) + el
 * estado on/off de cada tipo de alerta por correo. Si no hay fila en
 * `alert_configs` para un tipo, se considera DESHABILITADO (no se envía nada
 * hasta que el admin lo active).
 */
@Injectable()
export class GetEmailAlertsSettingsAction {
  constructor(
    @InjectRepository(AlertConfig) private readonly configsRepo: Repository<AlertConfig>,
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
  ) {}

  async execute(companyId: number): Promise<EmailAlertsSettings> {
    const [owner, rows] = await Promise.all([
      this.usersRepo.findOne({
        where: { company_id: String(companyId), type: UserType.OWNER },
      }),
      this.configsRepo.find({ where: { company_id: String(companyId) } }),
    ]);

    const enabledByType = new Map(rows.map((r) => [r.type, r.enabled]));

    const alerts: EmailAlertSettingItem[] = EMAIL_ALERT_TYPES.map((type) => ({
      type,
      enabled: enabledByType.get(type) ?? false,
    }));

    return { recipientEmail: owner?.email ?? null, alerts };
  }
}
