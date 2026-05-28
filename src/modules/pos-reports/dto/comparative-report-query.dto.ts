import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Granularidades soportadas por el Informe Comparativo. EXACTAMENTE las mismas
 * que el cálculo offline de PlacePos para garantizar paridad de períodos.
 */
export const COMPARATIVE_GRANULARITIES = [
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'semiannual',
  'annual',
] as const;
export type ComparativeGranularity = (typeof COMPARATIVE_GRANULARITIES)[number];

/**
 * Query del endpoint `GET /pos-reports/comparative` (v2 — navegación de períodos).
 *
 * - `granularity`: opcional, uno de COMPARATIVE_GRANULARITIES. Default `monthly`.
 * - `reference`: fecha "hoy" ancla `YYYY-MM-DD` (IsDateString). Default = fecha
 *   UTC actual (resuelto en la action, no aquí, para no acoplar el DTO al reloj).
 * - `count`: nº de períodos consecutivos a mostrar. 2 o 3. Default 2.
 * - `offset`: cuántos períodos hacia atrás está el período MÁS NUEVO mostrado
 *   respecto del período actual. 0 = el más nuevo es el período en curso. Default 0.
 */
export class ComparativeReportQueryDto {
  @ApiPropertyOptional({ enum: COMPARATIVE_GRANULARITIES, default: 'monthly' })
  @IsOptional()
  @IsIn([...COMPARATIVE_GRANULARITIES], { message: 'granularity inválido' })
  granularity?: ComparativeGranularity;

  @ApiPropertyOptional({ example: '2026-06-26' })
  @IsOptional()
  @IsDateString({}, { message: 'reference debe ser una fecha ISO válida (YYYY-MM-DD)' })
  reference?: string;

  @ApiPropertyOptional({ example: 2, minimum: 2, maximum: 3, default: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'count debe ser entero' })
  @Min(2, { message: 'count mínimo 2' })
  @Max(3, { message: 'count máximo 3' })
  count?: number;

  @ApiPropertyOptional({ example: 0, minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset debe ser entero' })
  @Min(0, { message: 'offset mínimo 0' })
  offset?: number;
}
