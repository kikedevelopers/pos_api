import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { User } from '@/modules/users/entities/user.entity';

/**
 * Fila del listado `GET /superadmin/tenants`. Mapea un `owner` (con su company
 * eager-cargada por `ListOwnersAction`) a una vista plana orientada al panel
 * superadmin. NO incluye `subscriptionExpiresAt` porque `ListOwnersAction` no
 * carga la suscripción; ese dato vive en el detalle.
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
}

/**
 * Mapea un `owner` (User con `company` eager) a la fila del listado superadmin.
 * Si por alguna razón la company no viene cargada, los campos de company quedan
 * con un fallback neutro (no debería ocurrir: owner siempre tiene company).
 */
export function toSuperadminTenantListItemDto(owner: User): SuperadminTenantListItemDto {
  return {
    companyId: owner.company ? Number(owner.company.id) : Number(owner.company_id),
    companyName: owner.company?.name ?? '',
    ownerName: `${owner.name} ${owner.lastname}`.trim(),
    ownerEmail: owner.email,
    documentNumber: owner.company?.document_number ?? null,
    createdAt: owner.created_at.toISOString(),
  };
}
