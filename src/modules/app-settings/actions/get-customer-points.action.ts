import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { getCustomerPointsConfig } from '../internal/customer-points-config';
import type { CustomerPointsConfigDto } from '../dto/customer-points.dto';

/**
 * Lee la configuración del sistema de PUNTOS de cliente — espejo de
 * `placepos/src/main/server/routes/app-settings.routes.ts → GET /customer-points`.
 *
 * Devuelve los defaults (`enabled=false`, `pesoBase=1000`, `perBase=1`) si las
 * keys no existen para la company.
 */
@Injectable()
export class GetCustomerPointsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number): Promise<CustomerPointsConfigDto> {
    return getCustomerPointsConfig(this.dataSource.manager, companyId);
  }
}
