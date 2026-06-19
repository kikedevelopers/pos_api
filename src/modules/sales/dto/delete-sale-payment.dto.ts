import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Body opcional de `DELETE /sales/:saleId/payments/:paymentId`.
 *
 * Espejo placepos: el reverso de un pago acepta una razón opcional y una
 * llave de idempotencia (`client_operation_id`) para deduplicar reintentos
 * de red. Ambos campos son opcionales.
 */
export class DeleteSalePaymentDto {
  @ApiPropertyOptional({
    description: 'Motivo del reverso (auditoría). Se persiste en void_reason.',
    example: 'Pago registrado por error',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;

  @ApiPropertyOptional({
    description:
      'UUID v4 generado por el cliente para la intención de reverso. Idempotencia: un reintento con la misma llave devuelve el reverso previo sin descontar la cuenta dos veces.',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID(4)
  client_operation_id?: string;
}
