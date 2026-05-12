import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { AlertConfig } from '../entities/alert-config.entity';

/**
 * Lista todas las configuraciones de alerta de una company.
 *
 * Endpoint `GET /alert-configs`. Read puro.
 *
 * Orden estable (`type ASC`) para que el frontend pueda renderizar siempre
 * en el mismo orden sin importar la fecha de creación.
 */
@Injectable()
export class FindAllAlertConfigsAction {
  constructor(
    @InjectRepository(AlertConfig)
    private readonly repo: Repository<AlertConfig>,
  ) {}

  async execute(companyId: number): Promise<AlertConfig[]> {
    return this.repo.find({
      where: { company_id: String(companyId) },
      order: { type: 'ASC' },
    });
  }
}
