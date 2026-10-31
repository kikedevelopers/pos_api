import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Like, type Repository } from 'typeorm';

import { AppAlert } from '../entities/app-alert.entity';

/**
 * Endpoint `GET /app-alerts/unread-count`. Espejo PlacePos.
 *
 * Devuelve `{ count: number }`. Cubierto por índice parcial
 * `idx_app_alerts_company_unread`.
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class CountUnreadAlertsAction {
  constructor(
    @InjectRepository(AppAlert)
    private readonly repo: Repository<AppAlert>,
  ) {}

  async execute(companyId: number, hiddenTypePrefix: string | null = null): Promise<number> {
    return this.repo.count({
      where: {
        company_id: String(companyId),
        is_read: false,
        ...(hiddenTypePrefix ? { type: Not(Like(`${hiddenTypePrefix}%`)) } : {}),
      },
    });
  }
}
