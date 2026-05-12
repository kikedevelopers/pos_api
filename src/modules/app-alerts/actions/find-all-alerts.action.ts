import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { AppAlert } from '../entities/app-alert.entity';

export interface FindAllAlertsParams {
  unreadOnly: boolean;
  limit: number;
}

export interface FindAllAlertsResult {
  alerts: AppAlert[];
  unread_count: number;
}

/**
 * Lista alertas de una company. Endpoint `GET /app-alerts`.
 *
 * Espejo del `app-alerts.routes.ts` PlacePos:
 *
 *   - `?unread_only=true|false` (default false).
 *   - `?limit=N` (default 50, max 200).
 *   - Devuelve `{ alerts, unread_count }`. `unread_count` SIEMPRE sobre el
 *     total no leído de la company (no sobre el filtro) porque la UI lo
 *     usa como badge global.
 *
 * Optimización: `unread_count` se obtiene en paralelo con la lista para
 * evitar latencia adicional. Cubierto por índice parcial
 * `idx_app_alerts_company_unread`.
 *
 * Read puro — sin transacción.
 */
@Injectable()
export class FindAllAlertsAction {
  constructor(
    @InjectRepository(AppAlert)
    private readonly repo: Repository<AppAlert>,
  ) {}

  async execute(companyId: number, params: FindAllAlertsParams): Promise<FindAllAlertsResult> {
    const baseWhere = { company_id: String(companyId) } as const;
    const where = params.unreadOnly ? { ...baseWhere, is_read: false } : baseWhere;

    const [alerts, unread_count] = await Promise.all([
      this.repo.find({
        where,
        order: { created_at: 'DESC' },
        take: params.limit,
      }),
      this.repo.count({ where: { ...baseWhere, is_read: false } }),
    ]);

    return { alerts, unread_count };
  }
}
