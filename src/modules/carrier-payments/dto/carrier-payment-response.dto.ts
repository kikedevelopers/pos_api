import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { CarrierPayment, CarrierPaymentMethod } from '../entities/carrier-payment.entity';

/**
 * Shape de respuesta de `CarrierPayment`. Espejo PlacePos.
 */
export class CarrierPaymentResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 10 })
  carrier_credit_id!: number;

  @ApiPropertyOptional({
    example: 5,
    nullable: true,
    description: 'ID del carrier (resuelto desde el credit, no FK directa).',
  })
  carrier_id!: number | null;

  @ApiPropertyOptional({
    example: 12,
    nullable: true,
    description: 'ID de la compra asociada al credit.',
  })
  purchase_id!: number | null;

  @ApiPropertyOptional({
    example: 'PO-0001',
    nullable: true,
    description: 'purchase_number desnormalizado.',
  })
  purchase_number!: string | null;

  @ApiProperty({ example: 250.0 })
  amount!: number;

  @ApiProperty({ enum: CarrierPaymentMethod, example: CarrierPaymentMethod.CASH })
  payment_method!: CarrierPaymentMethod;

  @ApiPropertyOptional({ example: 1, nullable: true })
  bank_id!: number | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  wallet_id!: number | null;

  @ApiProperty({ example: 99, description: 'FK al financial_movement auditable.' })
  financial_movement_id!: number;

  @ApiPropertyOptional({ example: 'Abono transportista Transportes Caracas - Compra Nº PO-0001' })
  description!: string | null;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

/**
 * Convierte entidad + datos de join al DTO público.
 */
export function toCarrierPaymentResponseDto(
  payment: CarrierPayment,
  join: { carrier_id: number | null; purchase_id: number | null; purchase_number: string | null },
): CarrierPaymentResponseDto {
  return {
    id: Number(payment.id),
    carrier_credit_id: Number(payment.carrier_credit_id),
    carrier_id: join.carrier_id,
    purchase_id: join.purchase_id,
    purchase_number: join.purchase_number,
    amount: payment.amount,
    payment_method: payment.payment_method,
    bank_id: payment.bank_id !== null ? Number(payment.bank_id) : null,
    wallet_id: payment.wallet_id !== null ? Number(payment.wallet_id) : null,
    financial_movement_id: Number(payment.financial_movement_id),
    description: payment.description,
    created_by: payment.created_by,
    created_by_id: payment.created_by_id !== null ? Number(payment.created_by_id) : null,
    created_at: payment.created_at.toISOString(),
  };
}
