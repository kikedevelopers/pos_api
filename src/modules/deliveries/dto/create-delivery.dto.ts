import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type { DeliveryPaymentMethod } from '../entities/delivery.entity';

/**
 * Métodos de pago aceptados al registrar un domicilio.
 */
export const DELIVERY_PAYMENT_METHODS = ['on_delivery', 'cash_register'] as const;

/**
 * Payload de `POST /deliveries`.
 *
 * Multi-tenancy: `company_id` NUNCA viene en el payload — se toma del JWT vía
 * `@CurrentCompany()`.
 *
 *   - `invoice_id` opcional: si se envía, el domicilio se liga a esa venta
 *     (validada dentro del tenant) y se snapshotea su `ticket_number`.
 *   - `delivery_company_id` obligatorio: domiciliario (dentro del tenant).
 *   - `payment_method`:
 *       - `on_delivery`  → no toca caja.
 *       - `cash_register` → egreso de la caja del cajero (transacción
 *         atómica con validación de saldo).
 */
export class CreateDeliveryDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'ID de la venta ligada (debe pertenecer a la company). Opcional.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'invoice_id debe ser entero' })
  @Min(1, { message: 'invoice_id debe ser >= 1' })
  invoice_id?: number;

  @ApiProperty({ example: 1, description: 'ID del domiciliario (debe pertenecer a la company).' })
  @Type(() => Number)
  @IsInt({ message: 'delivery_company_id debe ser entero' })
  @Min(1, { message: 'Debe seleccionarse un domiciliario.' })
  delivery_company_id!: number;

  @ApiProperty({ example: 5000, description: 'Valor del domicilio. >= 0, hasta 2 decimales.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount debe ser un número con hasta 2 decimales' })
  @Min(0, { message: 'amount no puede ser negativo' })
  amount!: number;

  @ApiProperty({
    enum: DELIVERY_PAYMENT_METHODS,
    example: 'cash_register',
    description: 'on_delivery: cobra contra-entrega. cash_register: egreso de caja del cajero.',
  })
  @IsString()
  @IsIn([...DELIVERY_PAYMENT_METHODS], {
    message: 'payment_method inválido. Usa on_delivery o cash_register.',
  })
  payment_method!: DeliveryPaymentMethod;

  @ApiPropertyOptional({ example: 'Entregar después de las 6pm', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiProperty({ example: 'Calle 10 #5-23, Apto 301', minLength: 1, maxLength: 255 })
  @IsString()
  @MinLength(1, { message: 'destination_address no puede estar vacío' })
  @MaxLength(255)
  destination_address!: string;

  @ApiProperty({ example: 'María González', minLength: 1, maxLength: 120 })
  @IsString()
  @MinLength(1, { message: 'recipient_name no puede estar vacío' })
  @MaxLength(120)
  recipient_name!: string;
}
