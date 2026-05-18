import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ProductCostHistoryEvent } from '../entities/product-cost-history.entity';
import type { ProductPriceHistory } from '../entities/product-price-history.entity';

/**
 * Entry de respuesta para `GET /product-prices/:id/price-history`. Espejo PlacePos.
 *
 * Incluye datos JOIN-eados de `product_cost_history` (cuando aplica) para
 * dar contexto: ¿este cambio de precio fue manual o derivado de una compra?
 */
export class PriceHistoryEntryDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 7 })
  product_price_id!: number;

  @ApiProperty({ example: 42 })
  product_id!: number;

  @ApiPropertyOptional({ example: 99, nullable: true })
  cost_history_id!: number | null;

  @ApiPropertyOptional({ example: 17, nullable: true })
  purchase_id!: number | null;

  @ApiPropertyOptional({
    enum: ProductCostHistoryEvent,
    nullable: true,
    description: 'event_type del cost_history asociado (si existe).',
  })
  event_type!: ProductCostHistoryEvent | null;

  @ApiProperty({ example: 25.0 })
  sale_price!: number;

  @ApiProperty({ example: 0 })
  profit_before!: number;

  @ApiProperty({ example: 12.5 })
  profit_after!: number;

  @ApiProperty({ example: 0 })
  margin_before!: number;

  @ApiProperty({ example: 50.0 })
  margin_after!: number;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

/**
 * Helper para convertir entidad + join al DTO público.
 */
export function toPriceHistoryEntryDto(
  entry: ProductPriceHistory,
  joined: { purchase_id: number | null; event_type: ProductCostHistoryEvent | null },
): PriceHistoryEntryDto {
  return {
    id: Number(entry.id),
    product_price_id: Number(entry.product_price_id),
    product_id: Number(entry.product_id),
    cost_history_id: entry.cost_history_id !== null ? Number(entry.cost_history_id) : null,
    purchase_id: joined.purchase_id,
    event_type: joined.event_type,
    sale_price: entry.sale_price,
    profit_before: entry.profit_before,
    profit_after: entry.profit_after,
    margin_before: entry.margin_before,
    margin_after: entry.margin_after,
    created_by: entry.created_by,
    created_by_id: entry.created_by_id !== null ? Number(entry.created_by_id) : null,
    created_at: entry.created_at.toISOString(),
  };
}
