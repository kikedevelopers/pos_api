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
      'El panel calcula los días restantes a partir de esta fecha. En una SUCURSAL es ' +
      'siempre null: la vigencia es la del negocio principal (ver parentCompanyId).',
  })
  subscriptionExpiresAt!: string | null;

  @ApiProperty({
    example: false,
    description:
      'true si la fila es una SUCURSAL (companies.is_branch). Las sucursales vienen ' +
      'inmediatamente después de su negocio principal, ordenadas de más antigua a más nueva.',
  })
  isBranch!: boolean;

  @ApiPropertyOptional({
    example: 8,
    nullable: true,
    description: 'company_id del negocio principal. null cuando la fila ES el principal.',
  })
  parentCompanyId!: number | null;

  @ApiPropertyOptional({
    example: 'Esencia & Grano',
    nullable: true,
    description: 'Nombre del negocio principal. null cuando la fila ES el principal.',
  })
  parentCompanyName!: string | null;

  @ApiProperty({
    example: true,
    description:
      'Sucursal seleccionable vs suspendida (company_members.is_active). Siempre true ' +
      'en el negocio principal.',
  })
  active!: boolean;

  @ApiProperty({
    example: 'active',
    enum: ['active', 'pending', 'expired', 'no_link'],
    description:
      'Confirmación del correo del owner: `active` ya entró al enlace; `pending` tiene ' +
      'uno vigente sin usar; `expired` se le venció; `no_link` no tiene ninguno vivo. ' +
      'Las sucursales heredan el estado del owner.',
  })
  activationStatus!: string;

  @ApiPropertyOptional({
    example: '2026-08-12T14:00:00.000Z',
    nullable: true,
    description: 'Cuándo activó la cuenta. null si todavía no.',
  })
  activatedAt!: string | null;

  @ApiPropertyOptional({
    example: '2026-08-19T14:00:00.000Z',
    nullable: true,
    description: 'Vencimiento del último enlace de activación. null si no hay ninguno.',
  })
  activationLinkExpiresAt!: string | null;

  @ApiProperty({
    example: false,
    description:
      'true cuando reenviar el correo resolvería la situación. Un enlace VIGENTE no se ' +
      'reenvía: solo invalidaría el que el dueño quizá está a punto de pulsar. Siempre ' +
      'false en una sucursal (la activación es del owner).',
  })
  canResendActivation!: boolean;

  @ApiProperty({
    example: 'El dueño confirmó su correo y puede iniciar sesión.',
    description: 'Explicación del estado para el operador.',
  })
  activationReason!: string;
}
