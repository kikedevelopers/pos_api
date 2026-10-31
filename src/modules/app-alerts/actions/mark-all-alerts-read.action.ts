import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppAlert } from '../entities/app-alert.entity';
import { scopeWhere, type AlertScope } from '../internal/alert-scope';

export interface MarkAllAlertsReadResult {
  marked_count: number;
}

/**
 * Marca como leídas TODAS las no leídas del alcance del usuario (su negocio y,
 * si es dueño, los pedidos del agente de sus otras sucursales: lo mismo que ve
 * en la campana). Idempotente: sin pendientes, `marked_count = 0`.
 */
@Injectable()
export class MarkAllAlertsReadAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(scope: AlertScope): Promise<MarkAllAlertsReadResult> {
    return this.dataSource.transaction<MarkAllAlertsReadResult>(async (manager) => {
      let marked = 0;
      // `update` no acepta un OR: una actualización por condición del alcance.
      for (const where of scopeWhere(scope, { is_read: false })) {
        const result = await manager.update(AppAlert, where, { is_read: true });
        marked += result.affected ?? 0;
      }
      return { marked_count: marked };
    });
  }
}
