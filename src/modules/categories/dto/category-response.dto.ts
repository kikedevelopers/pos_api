import { ApiProperty } from '@nestjs/swagger';

import { Category } from '../entities/category.entity';

/**
 * Shape de respuesta del módulo categories — espejo byte-por-byte de
 * `placepos/src/main/server/routes/categories.routes.ts`.
 */
export class CategoryResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Bebidas' })
  name!: string;

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

/**
 * Convierte entidad `Category` al DTO público. Único punto de proyección —
 * los controllers nunca exponen la entidad cruda.
 */
export function toCategoryResponseDto(category: Category): CategoryResponseDto {
  return {
    id: Number(category.id),
    name: category.name,
    is_archived: category.is_archived,
    created_at: category.created_at.toISOString(),
    updated_at: category.updated_at.toISOString(),
  };
}

/**
 * Payload de `PUT /categories/:id/archive`. Espejo de PlacePos.
 */
export class ArchiveCategoryResponseDto {
  @ApiProperty({ example: true })
  archived!: true;
}
