import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayMaxSize, IsArray, IsBoolean, IsInt, Min } from 'class-validator';

/**
 * Payload de `PUT /inventory/show-in-pos` (bulk). Espejo PlacePos.
 */
export class BulkToggleShowInPosDto {
  @ApiProperty({ example: [1, 2, 3], type: [Number] })
  @IsArray()
  @ArrayMinSize(1, { message: 'Debe enviar al menos un id.' })
  @ArrayMaxSize(500, { message: 'Máximo 500 ids por petición.' })
  @IsInt({ each: true, message: 'Cada id debe ser entero.' })
  @Min(1, { each: true })
  ids!: number[];

  @ApiProperty({ example: true })
  @IsBoolean()
  show_in_pos!: boolean;
}

/**
 * Respuesta de `PUT /inventory/show-in-pos`.
 */
export class BulkToggleShowInPosResponseDto {
  @ApiProperty({ example: 2 })
  updated_count!: number;

  @ApiProperty({ example: [1, 2], type: [Number] })
  updated_ids!: number[];

  @ApiProperty({ example: [99], type: [Number] })
  not_found!: number[];

  @ApiProperty({ example: true })
  show_in_pos!: boolean;
}
