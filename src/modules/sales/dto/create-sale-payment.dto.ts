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
  Min,
} from 'class-validator';

import { SALE_PAYMENT_ACCOUNT_TYPES, type SalePaymentAccountTypeDto } from './create-sale.dto';

/**
 * Payload de `POST /sales/:id/payments`. Espejo PlacePos.
 *
 * Idempotencia: `uuid` v4 opcional para deduplicar reintentos.
 */
export class CreateSalePaymentDto {
  @ApiProperty({ enum: SALE_PAYMENT_ACCOUNT_TYPES, example: 'bank' })
  @IsString()
  @IsIn([...SALE_PAYMENT_ACCOUNT_TYPES], {
    message: 'account_type inválido. Usa wallet, bank o cash_register.',
  })
  account_type!: SalePaymentAccountTypeDto;

  @ApiProperty({ example: 1, description: 'ID de la cuenta receptora.' })
  @Type(() => Number)
  @IsInt({ message: 'account_id debe ser entero' })
  @Min(1, { message: 'Debe seleccionarse una caja, banco o billetera.' })
  account_id!: number;

  @ApiProperty({ example: 150.5 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount debe ser un número con hasta 2 decimales' })
  @IsPositive({ message: 'El monto del cobro debe ser mayor a cero' })
  amount!: number;

  @ApiPropertyOptional({ example: 0, description: 'Cambio devuelto (solo CASH).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'change_amount debe ser número con hasta 2 decimales' },
  )
  @Min(0, { message: 'change_amount debe ser >= 0' })
  change_amount?: number;

  @ApiPropertyOptional({
    example: '6b3b2f3a-2b3d-4b1c-9a4f-1234567890ab',
    description: 'UUID v4 idempotency. Retry con el mismo uuid devuelve el pago previo (200).',
  })
  @IsOptional()
  @IsUUID('4', { message: 'uuid debe ser un UUID v4 válido' })
  uuid?: string;
}
