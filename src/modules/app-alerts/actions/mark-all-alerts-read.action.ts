import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppAlert } from '../entities/app-alert.entity';

export interface MarkAllAlertsReadResult {
  marked_count: number;
}

/**
 * Marca como leídas todas las alertas no leídas de una company.
 *
 * Endpoint `PUT /app-alerts/read-all`. Espejo PlacePos: las alertas son del
 * negocio, no personales — "leer todas" las cierra para todos los usuarios
 * de la company.
 *
 * Devuelve `{ marked_count }`. Si no había alertas no leídas, `marked_count = 0`
 * (idempotente).
 *
 * Transacción para garantizar que el UPDATE masivo sea atómico frente a
 * lecturas concurrentes del unread_count.
 */
@Injectable()
export class MarkAllAlertsReadAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<MarkAllAlertsReadResult> {
    return this.dataSource.transaction<MarkAllAlertsReadResult>(async (manager) => {
      const result = await manager.update(
        AppAlert,
        { company_id: String(companyId), is_read: false },
        { is_read: true },
      );
      return { marked_count: result.affected ?? 0 };
    });
  }
}
