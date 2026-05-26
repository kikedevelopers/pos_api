import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DeliveryCompany } from '../entities/delivery-company.entity';
import { findDeliveryCompanyInCompany } from '../internal/delivery-lookups';

/**
 * Archiva / des-archiva un domiciliario.
 *
 * Contrato Domiciliarios: dos endpoints explícitos
 *   - `PUT /delivery-companies/:id/archive`   → `{ archived: true }`
 *   - `PUT /delivery-companies/:id/unarchive` → `{ archived: false }`
 *
 * Idempotente: re-archivar un ya-archivado (o re-activar un activo) es no-op
 * y devuelve el estado solicitado. El lookup incluye archivados para poder
 * leer el row en ambos estados.
 *
 * Multi-tenancy: `findDeliveryCompanyInCompany` valida el tenant.
 */
@Injectable()
export class ToggleDeliveryCompanyArchiveAction {
  private readonly logger = new Logger(ToggleDeliveryCompanyArchiveAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    id: number,
    companyId: number,
    archived: boolean,
    actorId: number,
  ): Promise<{ archived: boolean }> {
    await this.dataSource.transaction(async (manager) => {
      await findDeliveryCompanyInCompany(manager, id, companyId);

      await manager.update(
        DeliveryCompany,
        { id: String(id), company_id: String(companyId) },
        { is_archived: archived },
      );
    });

    this.logger.log({
      event: archived ? 'delivery_company.archived' : 'delivery_company.unarchived',
      companyId,
      deliveryCompanyId: id,
      actorId,
    });

    return { archived };
  }
}
