import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { DeliveryCompany } from '../entities/delivery-company.entity';

/**
 * Forma de un row de DeliveryCompany expuesto al cliente. `company_id` se
 * omite (el cliente nunca lo necesita y no debe ver IDs cross-tenant).
 */
export class DeliveryCompanyResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Domicilios El Rápido' })
  name!: string;

  @ApiPropertyOptional({ example: 'Calle 10 #5-23, Centro' })
  address!: string | null;

  @ApiProperty({ type: [String], example: ['3001234567', '6012345'] })
  phones!: string[];

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiPropertyOptional({ example: 'Kike Pacheco' })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 7 })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-05-12T10:00:01.234Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T10:00:01.234Z' })
  updated_at!: string;
}

/**
 * Serializa una `DeliveryCompany` al shape de respuesta. Convierte bigints a
 * number y dates a ISO string. **Nunca expone `company_id`.**
 */
export function toDeliveryCompanyResponseDto(company: DeliveryCompany): DeliveryCompanyResponseDto {
  return {
    id: Number(company.id),
    name: company.name,
    address: company.address,
    phones: Array.isArray(company.phones) ? company.phones : [],
    is_archived: company.is_archived,
    created_by: company.created_by,
    created_by_id: company.created_by_id !== null ? Number(company.created_by_id) : null,
    created_at: company.created_at.toISOString(),
    updated_at: company.updated_at.toISOString(),
  };
}
