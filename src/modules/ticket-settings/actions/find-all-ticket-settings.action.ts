import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { TicketSetting } from '../entities/ticket-setting.entity';

/**
 * Lista las cinco configuraciones de folios de una company.
 *
 * Endpoint `GET /ticket-settings`. Read puro — sin transacción.
 *
 * Orden estable (`ticket_type ASC`) para que el frontend pueda renderizar
 * siempre en el mismo orden sin importar el created_at de la migración.
 */
@Injectable()
export class FindAllTicketSettingsAction {
  constructor(
    @InjectRepository(TicketSetting)
    private readonly repo: Repository<TicketSetting>,
  ) {}

  async execute(companyId: number): Promise<TicketSetting[]> {
    return this.repo.find({
      where: { company_id: String(companyId) },
      order: { ticket_type: 'ASC' },
    });
  }
}
