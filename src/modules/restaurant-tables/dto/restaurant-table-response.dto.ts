import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { RestaurantTable, RestaurantTableStatus } from '../entities/restaurant-table.entity';

/** Shape público de una mesa. */
export class RestaurantTableResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Mesa 1' })
  name!: string;

  @ApiProperty({ example: 4 })
  seats!: number;

  @ApiPropertyOptional({ example: 3, nullable: true, description: 'Salón al que está anclada.' })
  salon_id!: number | null;

  @ApiProperty({
    example: false,
    description: 'true = creada dentro del salón (anclaje permanente); false = anclada o suelta.',
  })
  owned_by_salon!: boolean;

  @ApiProperty({ example: 'free', enum: ['free', 'occupied'] })
  status!: RestaurantTableStatus;

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 17, nullable: true })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-10-06T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-10-06T14:30:00.000Z' })
  updated_at!: string;
}

/** Único punto de proyección — el controller nunca expone la entidad cruda. */
export function toRestaurantTableResponseDto(table: RestaurantTable): RestaurantTableResponseDto {
  return {
    id: Number(table.id),
    name: table.name,
    seats: table.seats,
    salon_id: table.salon_id === null ? null : Number(table.salon_id),
    owned_by_salon: table.owned_by_salon,
    status: table.status,
    is_archived: table.is_archived,
    created_by: table.created_by,
    created_by_id: table.created_by_id === null ? null : Number(table.created_by_id),
    created_at: table.created_at.toISOString(),
    updated_at: table.updated_at.toISOString(),
  };
}

export class ArchiveRestaurantTableResponseDto {
  @ApiProperty({ example: true })
  archived!: true;
}
