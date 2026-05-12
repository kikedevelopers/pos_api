import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Query params de `GET /suppliers`.
 *
 * Paridad PlacePos: el endpoint local devuelve siempre la lista de suppliers
 * activos (filtrando `is_archived = false`) sin filtros adicionales. Aquí
 * añadimos `search`, `include_archived`, `limit`, `offset` como capacidades
 * cloud opt-in (el frontend Electron las ignora).
 */
export class ListSuppliersQueryDto {
  @ApiPropertyOptional({
    description: 'Substring case-insensitive sobre legal_name, broker, doc_number o phone.',
    maxLength: 100,
    example: 'distribuidora',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    description: 'Incluir suppliers archivados. Default false (espejo PlacePos).',
    example: 'false',
  })
  @IsOptional()
  @IsBooleanString()
  include_archived?: string;

  @ApiPropertyOptional({
    description: 'Máximo de filas.',
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
    description: 'Offset para paginación.',
    minimum: 0,
    example: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset debe ser entero' })
  @Min(0, { message: 'offset debe ser >= 0' })
  offset?: number;
}
