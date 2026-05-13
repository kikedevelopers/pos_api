import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

export const CREDIT_REPORT_STATUSES = ['ALL', 'PENDING', 'PARTIALLY_PAID', 'PAID'] as const;
export type CreditReportStatus = (typeof CREDIT_REPORT_STATUSES)[number];

/**
 * Query de `GET /reports/credits?dateFrom=&dateTo=&search=&status=`.
 *
 * Espejo PlacePos: todos los filtros son opcionales. `search` matchea
 * `customer_name`, `ticket_number` o `sale_number` con ILIKE.
 */
export class CreditsReportQueryDto {
  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Formato de fecha inválido (YYYY-MM-DD) en dateFrom',
  })
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-05-31' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Formato de fecha inválido (YYYY-MM-DD) en dateTo',
  })
  dateTo?: string;

  @ApiPropertyOptional({ example: 'Juan' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: CREDIT_REPORT_STATUSES, example: 'PENDING' })
  @IsOptional()
  @IsString()
  @IsIn([...CREDIT_REPORT_STATUSES])
  status?: CreditReportStatus;
}
