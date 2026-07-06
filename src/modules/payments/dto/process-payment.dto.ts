import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
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
  ValidateNested,
} from 'class-validator';

/**
 * Método de pago aceptado por `POST /payments`. Espejo byte-a-byte del
 * `PaymentMethodType` de PlacePos (`placepos/src/main/database/types.ts`).
 *
 *   - `CASH`     → impacta caja del actor (cash_register).
 *   - `TRANSFER` → impacta `Bank` (requiere `bank_id` + `bank_name`).
 *   - `CREDIT`   → NO crea `SalePayment`; sólo se registra el `SaleCredit`.
 *     En el nuevo contrato de PAGO DIVIDIDO el crédito ya NO viaja dentro de
 *     `payments[]`: se expresa con `is_credit` + `credit_amount` a nivel raíz.
 *   - `ADVANCE`  → redime el saldo a favor del cliente (`advance_balance`). NO
 *     mueve caja/banco (el dinero ya ingresó al crear el anticipo); solo
 *     descuenta `advance_balance`. No lleva banco ni admite vuelto. Requiere
 *     `customer_id` en la factura.
 */
export enum ProcessPaymentMethod {
  CASH = 'CASH',
  TRANSFER = 'TRANSFER',
  CREDIT = 'CREDIT',
  ADVANCE = 'ADVANCE',
}

/**
 * Un tender (entrega) dentro de un pago dividido. NUNCA representa crédito —
 * el crédito por remanente vive en los campos raíz `is_credit`/`credit_amount`.
 *
 * Invariantes (validadas en la action, no aquí, para devolver códigos de
 * negocio con el shape PlacePos):
 *
 *   - `amount_paid > 0` siempre (un tender de 0 no tiene sentido).
 *   - `TRANSFER` ⇒ `bank_id` no-null.
 *   - `change_amount > 0` sólo tiene sentido en `CASH` (sobrepago en efectivo).
 *     En `TRANSFER` debe ser 0 (no se da vuelto por transferencia).
 */
export class ProcessPaymentTenderDto {
  @ApiProperty({
    description: 'Método de este tender. CREDIT no es válido aquí. ADVANCE redime `advance_balance`.',
    enum: [
      ProcessPaymentMethod.CASH,
      ProcessPaymentMethod.TRANSFER,
      ProcessPaymentMethod.ADVANCE,
    ],
    example: ProcessPaymentMethod.CASH,
  })
  @IsEnum(ProcessPaymentMethod)
  payment_method!: ProcessPaymentMethod;

  @ApiProperty({
    description: 'Monto entregado por este método.',
    example: 100.0,
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  amount_paid!: number;

  @ApiPropertyOptional({
    description:
      'Vuelto devuelto al cliente. Sólo CASH con sobrepago; TRANSFER siempre 0. Default 0.',
    example: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  change_amount?: number;

  @ApiPropertyOptional({
    description: 'Id del banco receptor. Requerido cuando `payment_method=TRANSFER`.',
    example: 7,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @IsPositive()
  bank_id?: number | null;

  @ApiPropertyOptional({
    description: 'Nombre del banco (snapshot persistido en el SalePayment).',
    example: 'Bancolombia Ahorros',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  bank_name?: string | null;
}

/**
 * Payload de `POST /payments` — soporta PAGO DIVIDIDO (split tender).
 *
 * --------------------------------------------------------------------------
 * Nuevo contrato (paridad front nuevo)
 * --------------------------------------------------------------------------
 *
 * - `payments[]`: 1..N tenders (CASH/TRANSFER). El front nuevo SIEMPRE manda
 *   este array.
 * - `is_credit` + `credit_amount`: el remanente que va a crédito (ya calculado
 *   por el cliente). El crédito NO es un tender.
 * - Invariante de cuadre (validado en la action):
 *     Σ(amount_paid − change_amount) + credit_amount ≈ amount_due  (±0.01).
 *
 * --------------------------------------------------------------------------
 * Retrocompatibilidad (shape viejo plano)
 * --------------------------------------------------------------------------
 *
 * Callers viejos enviaban `payment_method` + `amount_paid` + `change_amount` +
 * `bank_id`/`bank_name` en la raíz, sin `payments[]`. La action normaliza ese
 * shape a `payments: [{ ... }]` cuando `payments` no llega. Los campos planos
 * se mantienen OPCIONALES aquí únicamente para no romper esos clientes; el
 * front nuevo no los envía.
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
    description: 'Total adeudado por la venta. Debe coincidir (±0.01) con `sale.total`.',
    example: 150.0,
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  amount_due!: number;

  @ApiPropertyOptional({
    description:
      'Tenders del pago dividido (1..N). El front nuevo SIEMPRE lo envía. Si se omite, la action intenta normalizar el shape plano legado (`payment_method`/`amount_paid`/...).',
    type: [ProcessPaymentTenderDto],
  })
  @IsOptional()
  @IsArray()
  // NO exigimos un mínimo de elementos: una venta 100% a crédito viaja con
  // `payments: []` (el remanente va en `is_credit`/`credit_amount`, que NO es un
  // tender). La regla "al menos un tender O crédito" la valida la action.
  @ValidateNested({ each: true })
  @Type(() => ProcessPaymentTenderDto)
  payments?: ProcessPaymentTenderDto[];

  @ApiProperty({
    description:
      '`true` si la venta deja saldo pendiente como crédito. Requiere `customer_id` en la venta.',
    example: false,
  })
  @IsBoolean()
  is_credit!: boolean;

  @ApiProperty({
    description: 'Monto del remanente que va a crédito. `0` si todo se pagó con tender.',
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
  due_date?: string | null;

  // ------------------------------------------------------------------------
  // Campos planos LEGADOS (retrocompat). Opcionales — el front nuevo no los
  // envía. La action los usa sólo si `payments` no llega.
  // ------------------------------------------------------------------------

  @ApiPropertyOptional({
    description: '[LEGADO] Método de pago plano. Use `payments[]` en su lugar.',
    enum: ProcessPaymentMethod,
    example: ProcessPaymentMethod.CASH,
  })
  @IsOptional()
  @IsEnum(ProcessPaymentMethod)
  payment_method?: ProcessPaymentMethod;

  @ApiPropertyOptional({
    description: '[LEGADO] Monto entregado plano. Use `payments[]` en su lugar.',
    example: 200.0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  amount_paid?: number;

  @ApiPropertyOptional({
    description: '[LEGADO] Vuelto plano. Use `payments[]` en su lugar.',
    example: 50.0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Type(() => Number)
  change_amount?: number;

  @ApiPropertyOptional({
    description: '[LEGADO] Id del banco plano. Use `payments[]` en su lugar.',
    example: 7,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @IsPositive()
  bank_id?: number | null;

  @ApiPropertyOptional({
    description: '[LEGADO] Nombre del banco plano. Use `payments[]` en su lugar.',
    example: 'Bancolombia Ahorros',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  bank_name?: string | null;

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
