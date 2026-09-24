import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { SALES_DATE_FIELDS, type SalesDateField } from './sales-report-query.dto';

/**
 * Query de `GET /pos-reports/inventory-loans` — informe "Préstamo de Inventario".
 *
 * Un préstamo (ticket_type = 'LOAN') no tiene notas, créditos ni pagos, así que
 * el filtro es mucho más simple que el del informe de ventas: rango de fechas,
 * búsqueda por cliente/número de ticket y opción de incluir anulados.
 */
export class InventoryLoansQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido en dateFrom' })
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido en dateTo' })
  dateTo?: string;

  @ApiPropertyOptional({ example: 'PED-8270' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'search demasiado largo (máx 100 caracteres)' })
  search?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @Transform(({ value }): boolean => value === true || value === 'true')
  showDeleted?: boolean;

  @ApiPropertyOptional({ enum: SALES_DATE_FIELDS, example: 'sold_at' })
  @IsOptional()
  @IsIn([...SALES_DATE_FIELDS], { message: 'dateField inválido' })
  dateField?: SalesDateField;
}
