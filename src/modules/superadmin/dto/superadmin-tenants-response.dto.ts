import { ApiProperty } from '@nestjs/swagger';

import { SuperadminTenantListItemDto } from './superadmin-tenant-list-item.dto';

/**
 * Respuesta paginada de `GET /superadmin/tenants`.
 */
export class SuperadminTenantsResponseDto {
  @ApiProperty({ type: [SuperadminTenantListItemDto] })
  tenants!: SuperadminTenantListItemDto[];

  @ApiProperty({ example: 128, description: 'Total de tenants que matchean (sin paginar).' })
  total!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
