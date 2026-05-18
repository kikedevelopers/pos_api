import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query params para los endpoints `/cost-history` y `/price-history`.
 * Solo `limit` (default 20, max 100).
 */
export class HistoryQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    example: 20,
    description: 'Máximo de entradas a devolver (default 20, max 100).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser entero' })
  @Min(1, { message: 'limit debe ser >= 1' })
  @Max(100, { message: 'limit no puede exceder 100' })
  limit?: number;
}
