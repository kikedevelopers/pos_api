import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Min } from 'class-validator';

/**
 * Query params de `GET /carrier-payments`. Sin paginación (espejo PlacePos).
 */
export class ListCarrierPaymentsQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'Filtra pagos cuyos credits pertenezcan a este carrier.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'carrier_id debe ser entero' })
  @Min(1)
  carrier_id?: number;

  @ApiPropertyOptional({ example: '2026-05-01', description: 'Fecha desde (YYYY-MM-DD).' })
  @IsOptional()
  @IsDateString({}, { message: 'from debe ser un ISO date string válido (YYYY-MM-DD)' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-05-31', description: 'Fecha hasta (YYYY-MM-DD).' })
  @IsOptional()
  @IsDateString({}, { message: 'to debe ser un ISO date string válido (YYYY-MM-DD)' })
  to?: string;
}
