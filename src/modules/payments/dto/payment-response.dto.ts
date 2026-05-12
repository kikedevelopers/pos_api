import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { PaymentKind } from './list-payments-query.dto';

/**
 * Row del agregador `/payments`. Forma común que permite al frontend procesar
 * pagos de venta y de compra uniformemente.
 */
export class PaymentItemDto {
  @ApiProperty({ enum: ['sale', 'purchase'], example: 'sale' })
  kind!: PaymentKind;

  @ApiProperty({ example: 1 })
  payment_id!: number;

  @ApiProperty({ example: 10, description: 'ID de la venta o compra origen.' })
  reference_id!: number;

  @ApiPropertyOptional({
    example: '001',
    description: 'ticket_number/sale_number (sale) o purchase_number (purchase). Snapshot para UI.',
  })
  reference_number!: string | null;

  @ApiProperty({ example: 5, description: 'customer_id o supplier_id.' })
  counterparty_id!: number | null;

  @ApiPropertyOptional({ example: 'Juan Pérez' })
  counterparty_name!: string | null;

  @ApiProperty({
    enum: ['CASH', 'TRANSFER'],
    example: 'CASH',
    description: 'Método de pago snapshot al momento del cobro/abono.',
  })
  payment_method!: 'CASH' | 'TRANSFER';

  @ApiProperty({ example: 150.5 })
  amount!: number;

  @ApiPropertyOptional({
    example: 0,
    description: 'Solo aplica a kind=sale (cambio entregado al cliente).',
  })
  change_amount!: number | null;

  @ApiPropertyOptional({ example: 'wallet' })
  account_type!: string | null;

  @ApiPropertyOptional({ example: 1 })
  account_id!: number | null;

  @ApiPropertyOptional({ example: 'Banco Provincial' })
  bank_name!: string | null;

  @ApiPropertyOptional({ example: 'Abono parcial — cheque #123' })
  notes!: string | null;

  @ApiPropertyOptional({ example: '6b3b2f3a-2b3d-4b1c-9a4f-1234567890ab' })
  uuid!: string | null;

  @ApiPropertyOptional({ example: 'Kike Pacheco' })
  created_by!: string | null;

  @ApiProperty({ example: '2026-05-12T10:00:01.234Z' })
  created_at!: string;
}

/**
 * Shape de respuesta paginada del agregador `/payments`.
 */
export class ListPaymentsResponseDto {
  @ApiProperty({ type: [PaymentItemDto] })
  items!: PaymentItemDto[];

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
