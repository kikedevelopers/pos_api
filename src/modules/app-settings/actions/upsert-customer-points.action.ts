import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { setCustomerPointsConfig } from '../internal/customer-points-config';
import type { CustomerPointsConfigDto, UpdateCustomerPointsDto } from '../dto/customer-points.dto';

/**
 * Set de la configuración del sistema de PUNTOS de cliente — espejo de
 * `placepos/src/main/server/routes/app-settings.routes.ts → PUT /customer-points`.
 *
 * El guard de rol (`owner` | `manager`) vive en el controller (afecta el
 * otorgamiento de puntos en TODAS las ventas). Aquí solo persistimos las 3
 * keys en una transacción (upsert atómico por `(company_id, key)`).
 */
@Injectable()
export class UpsertCustomerPointsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(dto: UpdateCustomerPointsDto, companyId: number): Promise<CustomerPointsConfigDto> {
    const cfg: CustomerPointsConfigDto = {
      enabled: dto.enabled,
      pesoBase: dto.pesoBase,
      perBase: dto.perBase,
    };
    await this.dataSource.transaction(async (manager) => {
      await setCustomerPointsConfig(manager, companyId, cfg);
    });
    return cfg;
  }
}
