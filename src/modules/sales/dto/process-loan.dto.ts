import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

/**
 * Payload de `POST /sales/:id/loan` — registra un préstamo de mercancía a un
 * tercero convirtiendo un pedido (ORDER) en `ticket_type = 'LOAN'`.
 *
 * NO lleva montos ni medios de pago: un préstamo descuenta stock pero NO mueve
 * dinero (sin `sale_payments`, caja, crédito ni puntos).
 */
export class ProcessLoanDto {
  @ApiProperty({
    description:
      'UUID v4 generado por el cliente para la intención de préstamo. Idempotencia: dos requests con la misma llave producen un solo préstamo y un solo descuento de stock. Se persiste en `sale_invoices.client_operation_id` al convertir.',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID(4)
  client_operation_id!: string;

  @ApiPropertyOptional({
    description:
      'Si `true` y el actor es owner, permite prestar aunque el stock no alcance (queda en negativo). Ignorado en cualquier otro rol. Paridad con el override de venta.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  override_stock?: boolean;
}
