import { ApiProperty } from '@nestjs/swagger';

import { SuperadminTenantListItemDto } from './superadmin-tenant-list-item.dto';

/**
 * Respuesta paginada de `GET /superadmin/tenants`.
 */
export class SuperadminTenantsResponseDto {
  @ApiProperty({
    type: [SuperadminTenantListItemDto],
    description:
      'Negocios principales de la página con sus sucursales intercaladas justo debajo. ' +
      'Puede tener MÁS elementos que `limit`: las sucursales no consumen cupo de página.',
  })
  tenants!: SuperadminTenantListItemDto[];

  @ApiProperty({
    example: 128,
    description:
      'Total de CUENTAS (negocios principales) que matchean, sin paginar. Las sucursales ' +
      'no se cuentan aquí: son parte de su cuenta.',
  })
  total!: number;

  @ApiProperty({
    example: 3,
    description: 'Sucursales incluidas en esta página (informativo para la UI).',
  })
  branchCount!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
