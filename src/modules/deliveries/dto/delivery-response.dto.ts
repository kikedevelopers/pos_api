import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { Delivery, DeliveryPaymentMethod } from '../entities/delivery.entity';

/**
 * Forma de un row de Delivery expuesto al cliente. `company_id` (tenant) se
 * omite. `delivery_company_id` SÍ se expone (es un id intra-tenant que el
 * frontend usa para filtrar/relacionar).
 */
export class DeliveryResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiPropertyOptional({ example: 10 })
  invoice_id!: number | null;

  @ApiPropertyOptional({ example: 'F-000123' })
  ticket_number!: string | null;

  @ApiProperty({ example: 1 })
  delivery_company_id!: number;

  @ApiProperty({ example: 'Domicilios El Rápido' })
  delivery_company_name!: string;

  @ApiProperty({ example: 5000 })
  amount!: number;

  @ApiProperty({ example: 'cash_register' })
  payment_method!: DeliveryPaymentMethod;

  @ApiPropertyOptional({ example: 'Entregar después de las 6pm' })
  notes!: string | null;

  @ApiProperty({ example: 'Calle 10 #5-23, Apto 301' })
  destination_address!: string;

  @ApiProperty({ example: 'María González' })
  recipient_name!: string;

  @ApiPropertyOptional({ example: 42 })
  cash_register_log_id!: number | null;

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiPropertyOptional({ example: 'Kike Pacheco' })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 7 })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-05-12T10:00:01.234Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T10:00:01.234Z' })
  updated_at!: string;
}

/**
 * Serializa una `Delivery` al shape de respuesta. Convierte bigints a number
 * y dates a ISO string. **Nunca expone `company_id`.**
 */
export function toDeliveryResponseDto(delivery: Delivery): DeliveryResponseDto {
  return {
    id: Number(delivery.id),
    invoice_id: delivery.invoice_id !== null ? Number(delivery.invoice_id) : null,
    ticket_number: delivery.ticket_number,
    delivery_company_id: Number(delivery.delivery_company_id),
    delivery_company_name: delivery.delivery_company_name,
    amount: Number(delivery.amount),
    payment_method: delivery.payment_method,
    notes: delivery.notes,
    destination_address: delivery.destination_address,
    recipient_name: delivery.recipient_name,
    cash_register_log_id:
      delivery.cash_register_log_id !== null ? Number(delivery.cash_register_log_id) : null,
    is_archived: delivery.is_archived,
    created_by: delivery.created_by,
    created_by_id: delivery.created_by_id !== null ? Number(delivery.created_by_id) : null,
    created_at: delivery.created_at.toISOString(),
    updated_at: delivery.updated_at.toISOString(),
  };
}

/**
 * Respuesta de `GET /deliveries/prefill/:invoiceId`. El frontend la usa para
 * pre-llenar el formulario de domicilio a partir de una venta.
 */
export class DeliveryPrefillResponseDto {
  @ApiProperty({ example: 10 })
  invoice_id!: number;

  @ApiPropertyOptional({ example: 'F-000123' })
  ticket_number!: string | null;

  @ApiPropertyOptional({ example: 'María González' })
  customer_name!: string | null;

  @ApiPropertyOptional({ example: 'Calle 10 #5-23' })
  customer_address!: string | null;

  @ApiProperty({ example: true })
  has_customer!: boolean;
}
