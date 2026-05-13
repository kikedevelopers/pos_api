import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Query de `GET /reports/daily-closure?date=YYYY-MM-DD`. Default: hoy UTC.
 */
export class DailyClosureQueryDto {
  @ApiPropertyOptional({ example: '2026-05-12' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido (YYYY-MM-DD)' })
  date?: string;
}
