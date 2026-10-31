import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppAlert } from '../entities/app-alert.entity';
import { scopeWhere, type AlertScope } from '../internal/alert-scope';

/**
 * Marca UNA alerta como leída. La alerta tiene que estar en el alcance del
 * usuario (su negocio activo o, si es dueño, un pedido del agente de otra de
 * sus sucursales); si no, 404. Idempotente.
 */
@Injectable()
export class MarkAlertReadAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, scope: AlertScope): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const alert = await manager.findOne(AppAlert, {
        where: scopeWhere(scope, { id: String(id) }),
      });
      if (!alert) {
        throw new NotFoundException('Alerta no encontrada');
      }
      if (alert.is_read === true) {
        return;
      }
      await manager.update(
        AppAlert,
        { id: alert.id, company_id: alert.company_id },
        { is_read: true },
      );
    });
  }
}
