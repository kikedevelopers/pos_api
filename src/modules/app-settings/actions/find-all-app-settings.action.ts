import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { AppSetting } from '../entities/app-setting.entity';

/**
 * Lista todos los `app_settings` de una company. Endpoint `GET /app-settings`.
 *
 * Read puro — sin transacción.
 *
 * Orden estable (`key ASC`) para que el frontend pueda renderizar siempre en
 * el mismo orden.
 */
@Injectable()
export class FindAllAppSettingsAction {
  constructor(
    @InjectRepository(AppSetting)
    private readonly repo: Repository<AppSetting>,
  ) {}

  async execute(companyId: number): Promise<AppSetting[]> {
    return this.repo.find({
      where: { company_id: String(companyId) },
      order: { key: 'ASC' },
    });
  }
}
