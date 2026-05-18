import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  ProductCostHistory,
  ProductCostHistoryDerivedFrom,
  ProductCostHistoryEvent,
} from '../entities/product-cost-history.entity';

/**
 * Entry de respuesta para `GET /products/:id/cost-history`. Espejo PlacePos.
 */
export class CostHistoryEntryDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 42 })
  product_id!: number;

  @ApiPropertyOptional({ example: 17, nullable: true })
  purchase_id!: number | null;

  @ApiPropertyOptional({
    example: 'PO-0001',
    nullable: true,
    description: 'Snapshot del purchase_number (resuelto vía join).',
  })
  purchase_number!: string | null;

  @ApiProperty({ enum: ProductCostHistoryEvent, example: ProductCostHistoryEvent.RECEIVE })
  event_type!: ProductCostHistoryEvent;

  @ApiProperty({
    enum: ProductCostHistoryDerivedFrom,
    example: ProductCostHistoryDerivedFrom.PURCHASE,
  })
  derived_from!: ProductCostHistoryDerivedFrom;

  @ApiProperty({ example: 0 })
  cost_before!: number;

  @ApiProperty({ example: 12.5 })
  cost_after!: number;

  @ApiProperty({ example: 25.0 })
  change_pct!: number;

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
export function toCostHistoryEntryDto(
  entry: ProductCostHistory,
  purchaseNumber: string | null,
): CostHistoryEntryDto {
  return {
    id: Number(entry.id),
    product_id: Number(entry.product_id),
    purchase_id: entry.purchase_id !== null ? Number(entry.purchase_id) : null,
    purchase_number: purchaseNumber,
    event_type: entry.event_type,
    derived_from: entry.derived_from,
    cost_before: entry.cost_before,
    cost_after: entry.cost_after,
    change_pct: entry.change_pct,
    created_by: entry.created_by,
    created_by_id: entry.created_by_id !== null ? Number(entry.created_by_id) : null,
    created_at: entry.created_at.toISOString(),
  };
}
