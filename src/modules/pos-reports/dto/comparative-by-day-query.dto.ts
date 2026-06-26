import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query de `GET /pos-reports/comparative/by-day`. Compara el MISMO día del mes
 * entre `count` meses (el mes de `reference` y los anteriores).
 *
 * - `reference`: fecha ancla `YYYY-MM-DD`. Default = fecha UTC actual (en la action).
 * - `day`: día del mes a comparar (1..31). Default = día de `reference`. Si un mes
 *   no tiene ese día se usa el último (clamped) en la action.
 * - `count`: nº de meses a mostrar. 2 o 3. Default 2.
 */
export class ComparativeByDayQueryDto {
  @ApiPropertyOptional({ example: '2026-06-26' })
  @IsOptional()
  @IsDateString({}, { message: 'reference debe ser una fecha ISO válida (YYYY-MM-DD)' })
  reference?: string;

  @ApiPropertyOptional({ example: 26, minimum: 1, maximum: 31 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'day debe ser entero' })
  @Min(1, { message: 'day mínimo 1' })
  @Max(31, { message: 'day máximo 31' })
  day?: number;

  @ApiPropertyOptional({ example: 2, minimum: 2, maximum: 3, default: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'count debe ser entero' })
  @Min(2, { message: 'count mínimo 2' })
  @Max(3, { message: 'count máximo 3' })
  count?: number;
}
