import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import { CarrierPaymentMethod } from '../entities/carrier-payment.entity';

/**
 * Payload de `POST /carrier-payments`.
 *
 * Reglas de combinación método ↔ fuente (validadas en el action por
 * `UnprocessableEntityException`):
 *   - `CASH`: ignora `bank_id`/`wallet_id` — usa la caja del usuario logueado.
 *   - `BANK`: requiere `bank_id`, prohíbe `wallet_id`.
 *   - `WALLET`: requiere `wallet_id`, prohíbe `bank_id`.
 */
export class CreateCarrierPaymentDto {
  @ApiProperty({ example: 10, description: 'ID del carrier_credit a abonar.' })
  @Type(() => Number)
  @IsInt({ message: 'carrier_credit_id debe ser entero' })
  @Min(1)
  carrier_credit_id!: number;

  @ApiProperty({ example: 250.0, description: 'Monto a abonar (>0).' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount debe ser numérico con hasta 2 decimales' })
  @IsPositive({ message: 'amount debe ser mayor a cero' })
  amount!: number;

  @ApiProperty({ enum: CarrierPaymentMethod, example: CarrierPaymentMethod.CASH })
  @IsEnum(CarrierPaymentMethod, {
    message: `payment_method debe ser uno de: ${Object.values(CarrierPaymentMethod).join(', ')}`,
  })
  payment_method!: CarrierPaymentMethod;

  @ApiPropertyOptional({ example: 1, description: 'Requerido si payment_method=BANK.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'bank_id debe ser entero' })
  @Min(1)
  bank_id?: number;

  @ApiPropertyOptional({ example: 1, description: 'Requerido si payment_method=WALLET.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'wallet_id debe ser entero' })
  @Min(1)
  wallet_id?: number;

  @ApiPropertyOptional({ example: 'Pago flete julio', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
