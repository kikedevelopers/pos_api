import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppAlert } from '../entities/app-alert.entity';
import { findAlertInCompany } from '../internal/alert-lookups';

/**
 * Marca una alerta como leída. Endpoint `PUT /app-alerts/:id/read`.
 *
 * Espejo PlacePos:
 *   - Idempotente: si la alerta ya está leída, no hace nada (NO sobrescribe
 *     timestamps). En esta fase no llevamos `read_at`/`read_by_id` porque
 *     la entidad simplificada no los expone, pero la idempotencia se
 *     mantiene como contrato de comportamiento.
 *   - 404 si la alerta no existe o pertenece a otra company.
 *
 * Devuelve void (el controller envía 200 con payload null).
 */
@Injectable()
export class MarkAlertReadAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const alert = await findAlertInCompany(manager, id, companyId);
      if (alert.is_read === true) {
        return;
      }
      await manager.update(
        AppAlert,
        { id: alert.id, company_id: String(companyId) },
        { is_read: true },
      );
    });
  }
}
