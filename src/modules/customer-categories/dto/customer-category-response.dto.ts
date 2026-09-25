import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { CustomerCategory } from '../entities/customer-category.entity';

/**
 * Shape de respuesta del módulo `customer-categories`. Espeja la forma de
 * `CategoryResponseDto` (categorías de producto) más los campos de auditoría
 * `created_by` / `created_by_id`, únicos de este dominio.
 */
export class CustomerCategoryResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Cliente Redes Sociales' })
  name!: string;

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 17, nullable: true })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-09-25T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-09-25T14:30:00.000Z' })
  updated_at!: string;
}

/**
 * Convierte entidad `CustomerCategory` al DTO público. Único punto de
 * proyección — los controllers nunca exponen la entidad cruda.
 */
export function toCustomerCategoryResponseDto(
  category: CustomerCategory,
): CustomerCategoryResponseDto {
  return {
    id: Number(category.id),
    name: category.name,
    is_archived: category.is_archived,
    created_by: category.created_by,
    created_by_id: category.created_by_id === null ? null : Number(category.created_by_id),
    created_at: category.created_at.toISOString(),
    updated_at: category.updated_at.toISOString(),
  };
}

/**
 * Payload de `PUT /customer-categories/:id/archive`.
 */
export class ArchiveCustomerCategoryResponseDto {
  @ApiProperty({ example: true })
  archived!: true;
}
