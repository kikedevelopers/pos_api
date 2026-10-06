import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  RestaurantTableResponseDto,
  toRestaurantTableResponseDto,
} from '@/modules/restaurant-tables/dto/restaurant-table-response.dto';
import type { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';

import type { Salon } from '../entities/salon.entity';

/** Shape público de un salón, con el número de mesas activas que agrupa. */
export class SalonResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Sur A' })
  name!: string;

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiProperty({ example: 8, description: 'Mesas activas ancladas al salón.' })
  table_count!: number;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 17, nullable: true })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-10-06T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-10-06T14:30:00.000Z' })
  updated_at!: string;
}

/** Detalle de un salón + sus mesas activas (para la vista de salón). */
export class SalonDetailResponseDto extends SalonResponseDto {
  @ApiProperty({ type: [RestaurantTableResponseDto] })
  tables!: RestaurantTableResponseDto[];
}

/**
 * Proyecta un `Salon` al DTO público. `tableCount` lo calcula el action (no es
 * una columna). Único punto de proyección — el controller nunca expone la
 * entidad cruda.
 */
export function toSalonResponseDto(salon: Salon, tableCount: number): SalonResponseDto {
  return {
    id: Number(salon.id),
    name: salon.name,
    is_archived: salon.is_archived,
    table_count: tableCount,
    created_by: salon.created_by,
    created_by_id: salon.created_by_id === null ? null : Number(salon.created_by_id),
    created_at: salon.created_at.toISOString(),
    updated_at: salon.updated_at.toISOString(),
  };
}

export function toSalonDetailResponseDto(
  salon: Salon,
  tables: RestaurantTable[],
): SalonDetailResponseDto {
  return {
    ...toSalonResponseDto(salon, tables.length),
    tables: tables.map(toRestaurantTableResponseDto),
  };
}

export class ArchiveSalonResponseDto {
  @ApiProperty({ example: true })
  archived!: true;
}
