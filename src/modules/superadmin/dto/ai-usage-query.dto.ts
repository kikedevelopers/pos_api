import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

/** Rango (días de Colombia) del consumo de Place. Por defecto, últimos 30 días. */
export class AiUsageQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'from debe ser YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-17' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'to debe ser YYYY-MM-DD' })
  to?: string;
}
