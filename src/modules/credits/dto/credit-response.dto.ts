import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { CreditKind, CreditStatusValue } from './list-credits-query.dto';

/**
 * Row del agregador `/credits`. Forma común que permite al frontend procesar
 * créditos de venta y de compra uniformemente.
 *
 * Campo `kind` discrimina origen. `counterparty_*` denota la contraparte:
 *   - kind = 'sale': customer.
 *   - kind = 'purchase': supplier.
 */
export class CreditItemDto {
  @ApiProperty({ enum: ['sale', 'purchase'], example: 'sale' })
  kind!: CreditKind;

  @ApiProperty({ example: 1 })
  credit_id!: number;

  @ApiProperty({ example: 10, description: 'ID de la venta o compra origen.' })
  reference_id!: number;

  @ApiPropertyOptional({
    example: '001',
    description: 'ticket_number/sale_number (sale) o purchase_number (purchase). Snapshot para UI.',
  })
  reference_number!: string | null;

  @ApiProperty({ example: 5, description: 'customer_id o supplier_id.' })
  counterparty_id!: number;

  @ApiPropertyOptional({ example: 'Juan Pérez' })
  counterparty_name!: string | null;

  @ApiProperty({ example: 1000.0 })
  total_amount!: number;

  @ApiProperty({ example: 300.0 })
  paid_amount!: number;

  @ApiProperty({ example: 700.0 })
  balance!: number;

  @ApiProperty({ enum: ['PENDING', 'PARTIALLY_PAID', 'PAID'], example: 'PARTIALLY_PAID' })
  status!: CreditStatusValue;

  @ApiPropertyOptional({
    example: '2026-06-12',
    description: 'Solo aplica a kind=sale (los purchase_credits no tienen due_date).',
  })
  due_date!: string | null;

  @ApiProperty({ example: '2026-05-12T10:00:01.234Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T10:00:01.234Z' })
  updated_at!: string;
}

/**
 * Shape de respuesta paginada del agregador.
 */
export class ListCreditsResponseDto {
  @ApiProperty({ type: [CreditItemDto] })
  items!: CreditItemDto[];

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
