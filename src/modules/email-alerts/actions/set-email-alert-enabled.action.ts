import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { AlertConfig } from '@/modules/alert-configs/entities/alert-config.entity';

import type { EmailAlertType } from '../constants';

/**
 * Enciende/apaga un tipo de alerta por correo para una company (upsert sobre
 * `alert_configs`, respetando `UNIQUE(company_id, type)`). Gestiona solo la
 * columna `enabled`; el `config` jsonb queda como esté (o `{}` al crear).
 */
@Injectable()
export class SetEmailAlertEnabledAction {
  constructor(
    @InjectRepository(AlertConfig) private readonly repo: Repository<AlertConfig>,
  ) {}

  async execute(
    companyId: number,
    type: EmailAlertType,
    enabled: boolean,
  ): Promise<{ type: EmailAlertType; enabled: boolean }> {
    const existing = await this.repo.findOne({
      where: { company_id: String(companyId), type },
    });

    if (existing) {
      existing.enabled = enabled;
      await this.repo.save(existing);
    } else {
      await this.repo.insert({
        company_id: String(companyId),
        type,
        enabled,
        threshold: null,
        config: {},
      });
    }

    return { type, enabled };
  }
}
