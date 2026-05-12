import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Tipo de pago. Permite filtrar el agregador.
 */
export const PAYMENT_KIND = ['sale', 'purchase'] as const;
export type PaymentKind = (typeof PAYMENT_KIND)[number];

/**
 * Query del agregador `GET /payments`. Filtros opcionales + paginación.
 *
 * Espejo de la idea PlacePos `list-all-payments` (vista consolidada).
 */
export class ListPaymentsQueryDto {
  @ApiPropertyOptional({ enum: PAYMENT_KIND, example: 'sale' })
  @IsOptional()
  @IsString()
  @IsIn([...PAYMENT_KIND])
  type?: PaymentKind;

  @ApiPropertyOptional({
    example: 5,
    description: 'Filtra pagos de venta a un customer (ignorado si type=purchase).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  customer_id?: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'Filtra pagos de compra a un supplier (ignorado si type=sale).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  supplier_id?: number;

  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsDateString({}, { message: 'date_from debe ser un ISO date string válido' })
  date_from?: string;

  @ApiPropertyOptional({ example: '2026-05-31' })
  @IsOptional()
  @IsDateString({}, { message: 'date_to debe ser un ISO date string válido' })
  date_to?: string;

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
