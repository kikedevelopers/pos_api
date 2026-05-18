import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  PURCHASE_PAYMENT_SOURCE_TYPES,
  type PurchasePaymentSource,
} from './create-purchase-payment.dto';

/**
 * Un item del lote de abonos. Espejo PlacePos
 * (`BulkPurchasePaymentItem` en `bulkPaymentTypes`).
 *
 * Idempotencia per-item: cada abono puede traer su propio `uuid`. Si llega
 * un uuid ya procesado para la misma compra, el helper devuelve ese pago
 * sin reaplicar (paridad con el flujo single).
 */
export class BulkPurchasePaymentItemDto {
  @ApiProperty({ example: 1, description: 'ID de la compra a la que se aplica el abono.' })
  @Type(() => Number)
  @IsInt({ message: 'purchase_id debe ser entero' })
  @Min(1, { message: 'purchase_id debe ser >= 1' })
  purchase_id!: number;

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

  @ApiPropertyOptional({ example: 'Pago parcial', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiPropertyOptional({
    example: '6b3b2f3a-2b3d-4b1c-9a4f-1234567890ab',
    description:
      'UUID v4 idempotency key. Si llega un uuid ya procesado, se devuelve el pago existente.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'uuid debe ser un UUID v4 válido' })
  uuid?: string;
}

/**
 * Payload de `POST /purchases/bulk-payments`. Espejo PlacePos
 * `BulkPurchasePaymentBody`.
 */
export class BulkPurchasePaymentsDto {
  @ApiProperty({
    type: [BulkPurchasePaymentItemDto],
    description: 'Lista de abonos a aplicar atómicamente. Al menos uno.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Debe enviarse al menos un abono' })
  @ValidateNested({ each: true })
  @Type(() => BulkPurchasePaymentItemDto)
  payments!: BulkPurchasePaymentItemDto[];
}
