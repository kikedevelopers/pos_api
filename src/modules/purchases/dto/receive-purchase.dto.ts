import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Payload de `PUT /purchases/:id/receive`. Espejo PlacePos
 * `ReceivePurchasePayload`:
 *
 *   { received_by: string; received_at?: string | null;
 *     client_operation_id?: string | null }
 *
 * `carrier_name` NO viene en el receive — el cliente PlacePos ya lo persistió
 * en `Purchase.carrier_name` durante `POST /purchases`. Si en una futura
 * versión el cliente quisiera permitir cambiar el carrier al recibir, lo
 * agregaríamos opcional aquí. Por ahora la action conserva el snapshot.
 */
export class ReceivePurchaseDto {
  @ApiProperty({ example: 'Juan Pérez', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'El receptor es obligatorio' })
  @MaxLength(100)
  received_by!: string;

  @ApiPropertyOptional({
    example: '2026-05-22T12:00:00.000Z',
    nullable: true,
    description:
      'Fecha de recepción de la compra (ISO 8601). Si no llega, se usa `now()`. El cliente PlacePos materializa la fecha elegida por el usuario a las 12:00 locales para evitar saltos de día por timezone.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString({}, { message: 'received_at debe ser fecha ISO 8601' })
  received_at?: string | null;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    nullable: true,
    description:
      'UUID v4 generado por el cliente para deduplicar reintentos. Aceptado por paridad placepos; la idempotencia server-side completa para este endpoint queda pendiente.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID(4)
  client_operation_id?: string | null;
}
