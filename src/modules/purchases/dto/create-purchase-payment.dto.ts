import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Tipos de origen aceptados al registrar un pago. Espejo PlacePos
 * (`PurchasePaymentSource`).
 */
export const PURCHASE_PAYMENT_SOURCE_TYPES = ['wallet', 'bank', 'cash_register'] as const;
export type PurchasePaymentSource = (typeof PURCHASE_PAYMENT_SOURCE_TYPES)[number];

/**
 * Payload de `POST /purchases/:id/payments`. Espejo PlacePos
 * `PurchasePaymentBody`.
 *
 * Idempotencia:
 *   - `uuid` opcional. Si viene, el service consulta `purchase_payments`
 *     por (company_id, uuid) ANTES del INSERT. Si ya existe, devuelve 200
 *     con el row existente.
 *   - Si NO viene, el service genera uno internamente (defensa por si el
 *     cliente legacy olvida enviarlo).
 */
export class CreatePurchasePaymentDto {
  @ApiProperty({
    enum: PURCHASE_PAYMENT_SOURCE_TYPES,
    example: 'bank',
    description: 'Tipo de cuenta origen del abono.',
  })
  @IsString()
  @IsIn([...PURCHASE_PAYMENT_SOURCE_TYPES], {
    message: 'Fuente del abono inválida. Usa wallet, bank o cash_register.',
  })
  source_type!: PurchasePaymentSource;

  @ApiProperty({
    example: 1,
    description: 'ID de la cuenta origen (debe pertenecer a la company).',
  })
  @Type(() => Number)
  @IsInt({ message: 'source_id debe ser entero' })
  @Min(1, { message: 'Debe seleccionarse una caja, banco o billetera.' })
  source_id!: number;

  @ApiProperty({ example: 150.5, description: 'Monto del abono. Positivo, hasta 2 decimales.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount debe ser un número con hasta 2 decimales' })
  @IsPositive({ message: 'El monto del abono debe ser mayor a cero' })
  amount!: number;

  @ApiPropertyOptional({ example: 'Abono parcial — pago en cheque.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiPropertyOptional({
    example: '6b3b2f3a-2b3d-4b1c-9a4f-1234567890ab',
    description:
      'UUID v4 idempotency key. Si llega un uuid ya procesado, se devuelve el pago existente (200, sin duplicar).',
  })
  @IsOptional()
  @IsUUID('4', { message: 'uuid debe ser un UUID v4 válido' })
  uuid?: string;
}
