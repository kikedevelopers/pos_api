import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Fila del listado `GET /superadmin/tenants`. Vista plana de un `owner` con su
 * company y la vigencia de su suscripción (LEFT JOIN; puede no existir), tal
 * como la proyecta `ListTenantsAction` para el panel superadmin.
 */
export class SuperadminTenantListItemDto {
  @ApiProperty({ example: 8, description: 'company_id (bigint serializado a number).' })
  companyId!: number;

  @ApiProperty({ example: 'Surtidor La Esquina C.A.' })
  companyName!: string;

  @ApiProperty({ example: 'Kike Dev', description: 'Nombre + apellido del owner.' })
  ownerName!: string;

  @ApiProperty({ example: 'owner@empresa.com' })
  ownerEmail!: string;

  @ApiPropertyOptional({
    example: 'J-12345678-9',
    nullable: true,
    description: 'RIF/NIT/CUIT/RFC de la company.',
  })
  documentNumber!: string | null;

  @ApiProperty({
    example: '2026-05-12T14:30:00.000Z',
    description: 'Fecha de registro del owner (created_at).',
  })
  createdAt!: string;

  @ApiPropertyOptional({
    example: '2026-07-06T21:13:00.000Z',
    nullable: true,
    description:
      'Fecha/hora del último inicio de sesión del owner (users.last_login). ' +
      'null si nunca ha iniciado sesión. El panel lo usa para seguimiento de uso.',
  })
  lastLogin!: string | null;

  @ApiPropertyOptional({
    example: '2026-05-12T14:30:00.000Z',
    nullable: true,
    description: 'Inicio de la suscripción (started_at). null si el tenant no tiene suscripción.',
  })
  subscriptionStartedAt!: string | null;

  @ApiPropertyOptional({
    example: '2026-05-22T14:30:00.000Z',
    nullable: true,
    description:
      'Vencimiento de la suscripción (expires_at). null si el tenant no tiene suscripción. ' +
      'El panel calcula los días restantes a partir de esta fecha.',
  })
  subscriptionExpiresAt!: string | null;
}
