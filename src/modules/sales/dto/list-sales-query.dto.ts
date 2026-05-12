import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, Min } from 'class-validator';

import { TicketType } from '../entities/sale-invoice.entity';

/**
 * Query de `GET /sales`. Espejo PlacePos: por defecto retorna feed
 * cronológico DESC. `?limit=N` limita resultados. Filtros adicionales
 * (customer_id, ticket_type, date range) son extensiones opt-in.
 */
export class ListSalesQueryDto {
  @ApiPropertyOptional({
    example: 50,
    description: 'Máximo de resultados. Por defecto sin límite.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser entero' })
  @Min(1, { message: 'limit debe ser >= 1' })
  limit?: number;

  @ApiPropertyOptional({ enum: TicketType, description: 'Filtrar por tipo.' })
  @IsOptional()
  @IsEnum(TicketType, { message: 'ticket_type inválido' })
  ticket_type?: TicketType;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'customer_id debe ser entero' })
  @Min(1, { message: 'customer_id debe ser >= 1' })
  customer_id?: number;

  @ApiPropertyOptional({ example: '2026-05-01', description: 'Filtrar desde (inclusive).' })
  @IsOptional()
  @IsDateString({}, { message: 'date_from debe ser fecha válida' })
  date_from?: string;

  @ApiPropertyOptional({ example: '2026-05-31', description: 'Filtrar hasta (inclusive).' })
  @IsOptional()
  @IsDateString({}, { message: 'date_to debe ser fecha válida' })
  date_to?: string;

  @ApiPropertyOptional({
    description: 'Si true incluye ventas anuladas (is_deleted = true). Default: false.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  show_deleted?: boolean;
}
