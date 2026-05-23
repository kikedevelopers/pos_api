import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Método de pago aceptado por `POST /payments`. Espejo byte-a-byte del
 * `PaymentMethodType` de PlacePos (`placepos/src/main/database/types.ts`).
 *
 *   - `CASH`     → impacta caja del actor (cash_register).
 *   - `TRANSFER` → impacta `Bank` (requiere `bank_id` + `bank_name`).
 *   - `CREDIT`   → NO crea `SalePayment`; sólo se registra el `SaleCredit`.
 */
export enum ProcessPaymentMethod {
  CASH = 'CASH',
  TRANSFER = 'TRANSFER',
  CREDIT = 'CREDIT',
}

/**
 * Payload de `POST /payments` — espejo de `ProcessPaymentPayload` de PlacePos.
 *
 * --------------------------------------------------------------------------
 * Notas de contrato (paridad cliente PlacePos / Electron)
 * --------------------------------------------------------------------------
 *
 * - El payload NO es array. Es un único cobro plano con todos los datos del
 *   método (caja, banco o crédito) en el mismo objeto.
 * - El cliente envía números (`number`) para `amount_due`, `amount_paid`,
 *   `change_amount` y `credit_amount`. Internamente la action los pasa por
 *   `toBig(...)` para todo cálculo monetario.
 * - `bank_id` y `bank_name` SOLO son requeridos cuando `payment_method` es
 *   `TRANSFER`. PlacePos envía siempre ambos en ese caso (validamos el id).
 * - `due_date` solo tiene sentido si `is_credit && credit_amount > 0`.
 * - `override_margin` lo habilita el operador en la UI; el server solo aplica
 *   override si el actor es `owner` o `superadmin` (lo decide la action al
 *   invocar `assertMarginAboveMinimum`).
 */
export class ProcessPaymentDto {
  @ApiProperty({
    description: 'Id entero de la venta (SaleInvoice) tipo ORDER a cerrar.',
    example: 142,
  })
  @IsInt()
  @IsPositive()
  invoice_id!: number;

  @ApiProperty({
    description: 'Método de pago.',
    enum: ProcessPaymentMethod,
    example: ProcessPaymentMethod.CASH,
  })
  @IsEnum(ProcessPaymentMethod)
  payment_method!: ProcessPaymentMethod;

  @ApiProperty({
    description: 'Total adeudado por la venta. Debe coincidir (±0.01) con `sale.total`.',
    example: 150.0,
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  amount_due!: number;

  @ApiProperty({
    description: 'Monto que el cliente entrega. `0` si es CRÉDITO puro sin abono inicial.',
    example: 200.0,
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  amount_paid!: number;

  @ApiProperty({
    description: 'Vuelto devuelto al cliente. `0` si no hay vuelto.',
    example: 50.0,
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  change_amount!: number;

  @ApiProperty({
    description:
      '`true` si la venta deja saldo pendiente como crédito. Requiere `customer_id` en la venta.',
    example: false,
  })
  @IsBoolean()
  is_credit!: boolean;

  @ApiProperty({
    description: 'Monto del crédito generado. Debe ser `0` si `is_credit=false`.',
    example: 0,
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  credit_amount!: number;

  @ApiPropertyOptional({
    description: 'Fecha de vencimiento del crédito (ISO 8601). Solo aplica si `is_credit=true`.',
    example: '2026-06-30',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  due_date!: string | null;

  @ApiPropertyOptional({
    description:
      'Id del banco receptor. Requerido cuando `payment_method=TRANSFER`; debe ser `null` en otros casos.',
    example: 7,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @IsPositive()
  bank_id!: number | null;

  @ApiPropertyOptional({
    description:
      'Nombre del banco (snapshot persistido en el SalePayment). Requerido para TRANSFER.',
    example: 'Bancolombia Ahorros',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  bank_name!: string | null;

  @ApiPropertyOptional({
    description:
      'Si `true` y el actor es owner/superadmin, salta la verificación de margen mínimo. Ignorado en otros roles.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  override_margin?: boolean;

  @ApiPropertyOptional({
    description:
      'Si `true` y el actor es owner/superadmin, permite vender aunque el stock no alcance. El inventario quedará en negativo (clampeado a 0 si la diferencia sería negativa). Ignorado en otros roles. Paridad cliente PlacePos.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  override_stock?: boolean;

  @ApiPropertyOptional({
    description:
      'UUID v4 generado por el cliente para la intención de pago. Mismo propósito que el header `Idempotency-Key`. Si llega ambos, prevalece el header. Paridad cliente PlacePos (que lo envía en el body).',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID(4)
  client_operation_id?: string;
}
