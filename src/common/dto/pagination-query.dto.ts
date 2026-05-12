import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * DTO base reutilizable para endpoints paginados.
 *
 * Aviso: PlacePos rara vez pagina (consulta listas completas o usa
 * `?limit=N` plano). Este DTO está listo para módulos futuros que sí
 * necesiten paginación opt-in sin romper el contrato.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Número de página (1-indexed).',
    minimum: 1,
    default: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser entero' })
  @Min(1, { message: 'page debe ser >= 1' })
  page?: number;

  @ApiPropertyOptional({
    description: 'Tamaño de página. Máximo 1000.',
    minimum: 1,
    maximum: 1000,
    default: 50,
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser entero' })
  @Min(1, { message: 'limit debe ser >= 1' })
  @Max(1000, { message: 'limit no puede exceder 1000' })
  limit?: number;

  @ApiPropertyOptional({
    description: 'Campo por el que ordenar (depende del recurso).',
    example: 'created_at',
  })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiPropertyOptional({
    description: 'Dirección de orden.',
    enum: ['ASC', 'DESC'],
    default: 'DESC',
  })
  @IsOptional()
  @IsIn(['ASC', 'DESC'], { message: 'sortOrder debe ser ASC o DESC' })
  sortOrder?: 'ASC' | 'DESC';
}
