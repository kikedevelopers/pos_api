import { ApiProperty } from '@nestjs/swagger';

import { Packaging } from '@/modules/packagings/entities/packaging.entity';

/**
 * Shape de respuesta del módulo packagings. Espejo byte-a-byte del payload
 * que sirve `packagings.routes.ts` en PlacePos:
 *
 *   {
 *     id: number,
 *     name: string,
 *     value: number,
 *     is_archived: boolean,
 *     created_at: string  // ISO 8601
 *   }
 *
 * `created_by` y `company_id` NO se exponen (PlacePos tampoco los expone;
 * el frontend no los necesita).
 */
export class PackagingResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Caja x 12' })
  name!: string;

  @ApiProperty({ example: 12 })
  value!: number;

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

/**
 * Respuesta de `PUT /packagings/:id/archive`. PlacePos devuelve
 * `{ archived: true }` literal.
 */
export class ArchivePackagingResponseDto {
  @ApiProperty({ example: true })
  archived!: boolean;
}

/**
 * Convierte una entidad `Packaging` al DTO público. Único punto donde la
 * entidad cruda se proyecta a respuesta.
 *
 * `id` y `value`: PG entrega bigint como string y numeric a través del
 * transformer como number. Usamos `Number(...)` defensivamente para el id.
 */
export function toPackagingResponseDto(p: Packaging): PackagingResponseDto {
  return {
    id: Number(p.id),
    name: p.name,
    value: Number(p.value),
    is_archived: p.is_archived,
    created_at: p.created_at.toISOString(),
  };
}
