import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, type Repository } from 'typeorm';

import { AppAlert } from '../entities/app-alert.entity';
import { scopeWhere, type AlertScope } from '../internal/alert-scope';

/** Las LEÍDAS solo se listan si son de los últimos días (las no leídas, siempre). */
export const READ_ALERTS_RETENTION_DAYS = 7;

export interface FindAllAlertsParams {
  unreadOnly: boolean;
  limit: number;
  /** "Ahora" (inyectable en tests). */
  now?: Date;
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
 *   - Sin `unread_only`: las no leídas (todas) + las leídas de los últimos
 *     `READ_ALERTS_RETENTION_DAYS` días; lo leído y viejo ya no aporta.
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

  async execute(scope: AlertScope, params: FindAllAlertsParams): Promise<FindAllAlertsResult> {
    const unread = scopeWhere(scope, { is_read: false });
    const since = new Date(
      (params.now ?? new Date()).getTime() - READ_ALERTS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    // Arreglo = OR: no leídas (siempre) o leídas recientes.
    const where = params.unreadOnly
      ? unread
      : [...unread, ...scopeWhere(scope, { is_read: true, created_at: MoreThanOrEqual(since) })];

    const [alerts, unread_count] = await Promise.all([
      this.repo.find({
        where,
        // El nombre del negocio: una alerta de otra sucursal lo muestra.
        relations: { company: true },
        order: { created_at: 'DESC' },
        take: params.limit,
      }),
      this.repo.count({ where: unread }),
    ]);

    return { alerts, unread_count };
  }
}
