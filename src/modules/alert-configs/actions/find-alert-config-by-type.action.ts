import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { AlertConfig } from '../entities/alert-config.entity';
import { findConfigByType } from '../internal/alert-config-lookups';

/**
 * Lee una configuración de alerta por (company, type).
 *
 * Endpoint `GET /alert-configs/:type`. 404 si no existe.
 */
@Injectable()
export class FindAlertConfigByTypeAction {
  constructor(
    @InjectRepository(AlertConfig)
    private readonly repo: Repository<AlertConfig>,
  ) {}

  async execute(type: string, companyId: number): Promise<AlertConfig> {
    return findConfigByType(this.repo.manager, type, companyId);
  }
}
