import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Query de `GET /reports/extended-summary?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 *
 * Ambos params son OPCIONALES. Si faltan, la action aplica el default en hora
 * Colombia: `from` = primer día del mes actual, `to` = hoy. Aquí solo se valida
 * el formato; el rango se resuelve con `parseDateRange` (zona America/Bogota).
 */
export class ExtendedSummaryQueryDto {
  @ApiPropertyOptional({ example: '2026-06-01' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido (YYYY-MM-DD) en from' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido (YYYY-MM-DD) en to' })
  to?: string;
}
