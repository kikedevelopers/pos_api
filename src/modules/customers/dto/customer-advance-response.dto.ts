import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { CustomerAdvance, type AdvanceDestinationType } from '../entities/customer-advance.entity';

/**
 * Shape de respuesta de un anticipo (snake_case). Contrato:
 *
 *   { id, customer_id, amount, description, destination_type, destination_id,
 *     created_by, created_at }
 *
 * Los bigint de pg llegan como string; se castean a number (mismo criterio que
 * `CustomerResponseDto`). `created_at` se serializa ISO 8601.
 */
export class CustomerAdvanceResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 42 })
  customer_id!: number;

  @ApiProperty({ example: 12000000 })
  amount!: number;

  @ApiProperty({ example: 'Anticipo para pedido de mercancía' })
  description!: string;

  @ApiProperty({
    enum: ['cash_register', 'bank', 'wallet'],
    example: 'cash_register',
  })
  destination_type!: AdvanceDestinationType;

  @ApiProperty({ example: 5, description: 'Id real de la cuenta destino donde entró el dinero.' })
  destination_id!: number;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiProperty({ example: '2026-06-09T14:30:00.000Z' })
  created_at!: string;
}

/**
 * Proyecta una entidad `CustomerAdvance` al DTO público. Único punto de
 * serialización del anticipo (evita fugas de joins eager).
 */
export function toCustomerAdvanceResponseDto(advance: CustomerAdvance): CustomerAdvanceResponseDto {
  return {
    id: Number(advance.id),
    customer_id: Number(advance.customer_id),
    amount: advance.amount,
    description: advance.description,
    destination_type: advance.destination_type,
    destination_id: Number(advance.destination_id),
    created_by: advance.created_by,
    created_at: advance.created_at.toISOString(),
  };
}
