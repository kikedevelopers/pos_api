import { ApiProperty } from '@nestjs/swagger';

import type { TenantCustomersSummary } from '../actions/get-tenant-customers.action';
import type { ClearTenantCustomersResult } from '../actions/clear-tenant-customers.action';

/** Resumen de los clientes de un tenant (panel superadmin). */
export class SuperadminTenantCustomersDto {
  @ApiProperty({ description: 'Clientes activos (lo que el cliente ve en su lista)' })
  active!: number;

  @ApiProperty({ description: 'Clientes ya archivados' })
  archived!: number;

  @ApiProperty({ description: 'Se borrarían físicamente al vaciar (sin historial de negocio)' })
  deletable!: number;

  @ApiProperty({
    description: 'Se archivarían al vaciar (tienen ventas, créditos, notas o anticipos)',
  })
  protectable!: number;
}

export const toSuperadminTenantCustomersDto = (
  summary: TenantCustomersSummary,
): SuperadminTenantCustomersDto => ({ ...summary });

/** Resultado de vaciar la lista de clientes. */
export class SuperadminClearCustomersResponseDto {
  @ApiProperty({ description: 'Clientes borrados físicamente' })
  deleted!: number;

  @ApiProperty({ description: 'Clientes archivados (conservan su historial)' })
  archived!: number;

  @ApiProperty({ description: 'Clientes activos que quedan (debe ser 0)' })
  remaining!: number;
}

export const toSuperadminClearCustomersResponseDto = (
  result: ClearTenantCustomersResult,
): SuperadminClearCustomersResponseDto => ({ ...result });
