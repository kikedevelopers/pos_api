import { ApiProperty } from '@nestjs/swagger';

/**
 * Resultado de `POST /superadmin/tenants`. La cuenta queda lista para iniciar
 * sesión desde placepos (owner + company + seeds + suscripción trial de 10
 * días). No se devuelve JWT: el panel no inicia sesión por el owner.
 */
export class SuperadminCreateTenantResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: 12, description: 'Id de la company principal creada.' })
  companyId!: number;

  @ApiProperty({ example: 34, description: 'Id del usuario owner creado.' })
  ownerId!: number;

  @ApiProperty({ example: 'Bodegón Ares' })
  companyName!: string;

  @ApiProperty({ example: 'kike@ares.pos' })
  ownerEmail!: string;

  @ApiProperty({
    example: '2026-07-03T12:00:00.000Z',
    description: 'Vencimiento del trial (10 días desde la creación).',
  })
  subscriptionExpiresAt!: string;
}
