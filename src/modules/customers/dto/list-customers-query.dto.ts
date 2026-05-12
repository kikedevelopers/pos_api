import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Query params de `GET /customers`.
 *
 * Paridad PlacePos: el endpoint local NO acepta filtros — siempre devuelve
 * la lista completa ordenada por `created_at DESC`. Como capacidad cloud
 * OPCIONAL (no-breaking), admitimos:
 *
 *   - `search`: substring case-insensitive sobre `name`, `doc_number`, `phone`.
 *   - `include_archived`: si `true`, incluye archivados. Default `false`.
 *   - `limit` y `offset`: paginación opt-in.
 *
 * El frontend Electron de PlacePos no envía ninguno; recibe el mismo array
 * que siempre. Cualquier cliente cloud que quiera paginar lo hace explícito.
 */
export class ListCustomersQueryDto {
  @ApiPropertyOptional({
    description: 'Substring case-insensitive sobre name, doc_number o phone.',
    maxLength: 100,
    example: 'juan',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    description: 'Incluir clientes archivados. Default false.',
    example: 'false',
  })
  @IsOptional()
  // Aceptamos query string "true"/"false" como string para no obligar al
  // cliente a hacer transform manual. La normalización a boolean ocurre en
  // el action (StringToBoolean).
  @IsBooleanString()
  include_archived?: string;

  @ApiPropertyOptional({
    description: 'Máximo de filas. Default sin límite (paridad PlacePos).',
    minimum: 1,
    maximum: 1000,
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser entero' })
  @Min(1, { message: 'limit debe ser >= 1' })
  @Max(1000, { message: 'limit no puede exceder 1000' })
  limit?: number;

  @ApiPropertyOptional({
    description: 'Offset para paginación. Requiere limit.',
    minimum: 0,
    example: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset debe ser entero' })
  @Min(0, { message: 'offset debe ser >= 0' })
  offset?: number;
}
