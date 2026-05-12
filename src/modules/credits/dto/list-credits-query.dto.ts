import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Tipo de crédito. Permite filtrar el agregador para que el cliente pida
 * solo créditos a ventas o solo a compras. Si se omite, devuelve ambos.
 */
export const CREDIT_KIND = ['sale', 'purchase'] as const;
export type CreditKind = (typeof CREDIT_KIND)[number];

/**
 * Estados del crédito (espejo de `credit_status`). Postgres enum compartido
 * entre `sale_credits` y `purchase_credits`.
 */
export const CREDIT_STATUSES = ['PENDING', 'PARTIALLY_PAID', 'PAID'] as const;
export type CreditStatusValue = (typeof CREDIT_STATUSES)[number];

/**
 * Query del agregador `GET /credits`. Filtros opcionales + paginación.
 *
 * Espejo del concepto PlacePos `list-all-credits` (vista consolidada). No es
 * un CRUD — solo lectura union de sale_credits + purchase_credits.
 */
export class ListCreditsQueryDto {
  @ApiPropertyOptional({ enum: CREDIT_KIND, example: 'sale' })
  @IsOptional()
  @IsString()
  @IsIn([...CREDIT_KIND])
  type?: CreditKind;

  @ApiPropertyOptional({ enum: CREDIT_STATUSES, example: 'PARTIALLY_PAID' })
  @IsOptional()
  @IsString()
  @IsIn([...CREDIT_STATUSES])
  status?: CreditStatusValue;

  @ApiPropertyOptional({
    example: 5,
    description: 'Filtra créditos de venta de un customer (ignorado si type=purchase).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  customer_id?: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'Filtra créditos de compra de un supplier (ignorado si type=sale).',
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
