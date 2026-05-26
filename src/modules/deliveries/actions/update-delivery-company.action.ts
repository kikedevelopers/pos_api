import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateDeliveryCompanyDto } from '../dto/update-delivery-company.dto';
import { DeliveryCompany } from '../entities/delivery-company.entity';
import { findDeliveryCompanyInCompany } from '../internal/delivery-lookups';
import { normalizePhones } from './create-delivery-company.action';

/**
 * Actualiza un domiciliario (`PUT /delivery-companies/:id`). Reemplaza name,
 * address y phones por completo (contrato Domiciliarios). El snapshot
 * `delivery_company_name` de domicilios YA registrados NO se toca — preserva
 * la auditoría histórica.
 *
 * Multi-tenancy: `findDeliveryCompanyInCompany` valida el tenant.
 */
@Injectable()
export class UpdateDeliveryCompanyAction {
  private readonly logger = new Logger(UpdateDeliveryCompanyAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    id: number,
    dto: UpdateDeliveryCompanyDto,
    companyId: number,
  ): Promise<DeliveryCompany> {
    return this.dataSource.transaction<DeliveryCompany>(async (manager) => {
      await findDeliveryCompanyInCompany(manager, id, companyId);

      await manager.update(
        DeliveryCompany,
        { id: String(id), company_id: String(companyId) },
        {
          name: dto.name.trim(),
          address: dto.address?.trim() ? dto.address.trim() : null,
          phones: normalizePhones(dto.phones),
        },
      );

      this.logger.log({ event: 'delivery_company.updated', companyId, deliveryCompanyId: id });

      return findDeliveryCompanyInCompany(manager, id, companyId);
    });
  }
}
