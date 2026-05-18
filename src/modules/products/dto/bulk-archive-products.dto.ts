import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayMaxSize, IsArray, IsInt, Min } from 'class-validator';

/**
 * Payload de `PUT /inventory/archive` (bulk). Espejo PlacePos.
 *
 * Validaciones:
 *   - `ids`: array de enteros positivos. Mín 1, máx 500 por request para
 *     evitar payloads abusivos.
 *   - Dedup y filtrado adicional ocurren en el action.
 */
export class BulkArchiveProductsDto {
  @ApiProperty({
    example: [1, 2, 3],
    type: [Number],
    description: 'IDs de productos a archivar.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Debe enviar al menos un id.' })
  @ArrayMaxSize(500, { message: 'Máximo 500 ids por petición.' })
  @IsInt({ each: true, message: 'Cada id debe ser entero.' })
  @Min(1, { each: true })
  ids!: number[];
}

/**
 * Respuesta de `PUT /inventory/archive`. Mantenemos `archived_count` para
 * paridad con PlacePos (`archived: N`) + `archived_ids` y `not_found` para
 * el cliente.
 */
export class BulkArchiveProductsResponseDto {
  @ApiProperty({ example: 2 })
  archived_count!: number;

  @ApiProperty({ example: [1, 2], type: [Number] })
  archived_ids!: number[];

  @ApiProperty({ example: [99], type: [Number] })
  not_found!: number[];
}
