import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
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

import { preciseNumber } from '@/common/utils/precision';

import { TicketType } from '../entities/sale-invoice.entity';

/**
 * Transform factory para campos monetarios DERIVADOS (productos de `quantity`,
 * como `total = price * quantity` o `profit = (price - cost) * quantity`, y sus
 * agregados). El cliente los pre-calcula con Big.js SIN redondear (paridad
 * PlacePos), por lo que con cantidades fraccionarias (granel/peso) llegan con
 * más decimales que la escala de su columna. Redondeamos a `scale` ANTES de
 * validar (con `transform: true` en el ValidationPipe global) para no rechazar
 * la venta y persistir exactamente la precisión de la columna numeric.
 *
 * Solo toca valores numéricos finitos; deja pasar null/undefined/no-numérico
 * para que `@IsNumber` siga reportando un campo faltante o inválido.
 */
const roundToScale = (scale: number) =>
  Transform(({ value }) => {
    if (value === null || value === undefined || value === '') {
      return value;
    }
    // Guard: solo redondeamos numéricos finitos; lo demás lo reporta @IsNumber.
    if (!Number.isFinite(Number(value))) {
      return value;
    }
    // `preciseNumber` redondea con Big.js (toBig().round(scale, ROUND_HALF_UP)).
    // Pasamos el valor crudo a Big — sin coerción intermedia a `number`.
    return preciseNumber(value, scale);
  });

/**
 * Tipos de cuenta receptora aceptados al registrar un pago de venta. Espejo
 * PlacePos.
 */
export const SALE_PAYMENT_ACCOUNT_TYPES = ['wallet', 'bank', 'cash_register'] as const;
export type SalePaymentAccountTypeDto = (typeof SALE_PAYMENT_ACCOUNT_TYPES)[number];

/**
 * Pago embebido dentro del create de la venta (venta + pago combinado).
 *
 * Idempotencia:
 *   - `uuid` opcional. Si viene y ya existe `sale_payments(company_id, uuid)`,
 *     el service NO duplica el pago.
 */
export class CreateSalePaymentInlineDto {
  @ApiProperty({
    enum: SALE_PAYMENT_ACCOUNT_TYPES,
    example: 'cash_register',
    description: 'Tipo de cuenta receptora del cobro.',
  })
  @IsString()
  @IsIn([...SALE_PAYMENT_ACCOUNT_TYPES], {
    message: 'account_type inválido. Usa wallet, bank o cash_register.',
  })
  account_type!: SalePaymentAccountTypeDto;

  @ApiProperty({
    example: 1,
    description:
      'ID de la cuenta receptora. Para cash_register se ignora — usa el turno abierto activo.',
  })
  @Type(() => Number)
  @IsInt({ message: 'account_id debe ser entero' })
  @Min(1, { message: 'Debe seleccionarse una caja, banco o billetera.' })
  account_id!: number;

  @ApiProperty({ example: 150.5, description: 'Monto del cobro. Positivo, hasta 2 decimales.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount debe ser un número con hasta 2 decimales' })
  @IsPositive({ message: 'El monto del cobro debe ser mayor a cero' })
  amount!: number;

  @ApiPropertyOptional({
    example: 0,
    description: 'Cambio devuelto al cliente (solo aplica a CASH).',
    default: 0,
  })
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
    description:
      'UUID v4 idempotency key. Si llega un uuid ya procesado, se devuelve el pago existente (200, sin duplicar).',
  })
  @IsOptional()
  @IsUUID('4', { message: 'uuid debe ser un UUID v4 válido' })
  uuid?: string;
}

/**
 * Modo en que se asignó el precio a una línea. Espejo PlacePos
 * `SaleInvoiceLinePayload.price_mode`.
 *
 *   - `fixed` : se aplicó un nivel de precio del catálogo.
 *   - `manual`: el vendedor lo escribió a mano.
 */
export const SALE_LINE_PRICE_MODES = ['fixed', 'manual'] as const;
export type SaleLinePriceModeDto = (typeof SALE_LINE_PRICE_MODES)[number];

/**
 * Una línea del payload de `POST /sales`. Espejo byte-por-byte de
 * `SaleInvoiceLinePayload` de PlacePos (`placepos/src/main/database/types.ts`).
 *
 * El cliente PlacePos pre-calcula `cost`, `total`, `profit` y `margin` por
 * línea con Big.js y los envía como snapshot histórico. El service los
 * persiste tal cual (sin recalcular) — paridad estricta con el modo
 * servidor/cliente que confía en el cliente.
 *
 * Multi-tenancy: el service valida que cada `item_id` pertenezca a la
 * `company_id` del JWT antes de insertar.
 */
export class CreateSaleLineDto {
  @ApiProperty({
    example: 1,
    description: 'ID del producto vendido (debe pertenecer a la company).',
  })
  @Type(() => Number)
  @IsInt({ message: 'item_id debe ser entero' })
  @Min(1, { message: 'item_id debe ser >= 1' })
  item_id!: number;

  @ApiProperty({
    example: 'Aceite Diana 1L',
    description: 'Snapshot inmutable del nombre del producto al momento de la venta.',
  })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    example: 18.5,
    description: 'Costo unitario al momento de la venta (snapshot). >= 0.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'cost debe ser número con hasta 2 decimales' })
  @Min(0, { message: 'cost debe ser >= 0' })
  cost!: number;

  @ApiProperty({
    example: 25.5,
    description: 'Precio unitario al momento de la venta (snapshot). >= 0.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'price debe ser número con hasta 2 decimales' })
  @Min(0, { message: 'price debe ser >= 0' })
  price!: number;

  @ApiProperty({ example: 2, description: 'Cantidad vendida. > 0. Hasta 4 decimales.' })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'quantity debe ser un número con hasta 4 decimales' },
  )
  @IsPositive({ message: 'quantity debe ser mayor a cero' })
  quantity!: number;

  @ApiProperty({
    example: 51,
    description: 'Total de la línea (price * quantity). Pre-calculado por el cliente con Big.js.',
  })
  @Type(() => Number)
  @roundToScale(2)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'total debe ser número con hasta 2 decimales' })
  @Min(0, { message: 'total debe ser >= 0' })
  total!: number;

  @ApiProperty({
    example: 14,
    description: 'Ganancia de la línea ((price - cost) * quantity). Pre-calculada por el cliente.',
  })
  @Type(() => Number)
  @roundToScale(2)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'profit debe ser número con hasta 2 decimales' })
  profit!: number;

  @ApiProperty({
    example: 27.45,
    description: 'Margen porcentual de la línea (profit / total * 100). Hasta 4 decimales.',
  })
  @Type(() => Number)
  @roundToScale(4)
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'margin debe ser número con hasta 4 decimales' })
  margin!: number;

  @ApiProperty({
    enum: SALE_LINE_PRICE_MODES,
    example: 'fixed',
    description:
      'Cómo se determinó el precio de la línea. `fixed` = nivel del catálogo; `manual` = escrito por el vendedor.',
  })
  @IsString()
  @IsIn([...SALE_LINE_PRICE_MODES], {
    message: 'price_mode inválido. Usa fixed o manual.',
  })
  price_mode!: SaleLinePriceModeDto;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Índice del nivel de precio usado (0..n-1) cuando `price_mode = fixed`. null si manual.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'price_position debe ser entero' })
  @Min(0, { message: 'price_position debe ser >= 0' })
  price_position?: number | null;

  @ApiPropertyOptional({
    example: 'Sin cebolla, bien cocido.',
    description: 'Nota por línea de venta (una por producto). Opcional. null para limpiar.',
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'note no puede exceder 500 caracteres' })
  note?: string | null;
}

/**
 * Payload de `POST /sales`. Espejo byte-por-byte de `SaleInvoicePayload` de
 * PlacePos (`placepos/src/main/database/types.ts`).
 *
 * Multi-tenancy: el `company_id` se toma del JWT (`@CurrentCompany`), nunca
 * del body. El service valida que `customer_id` y todos los `item_id` de las
 * líneas pertenezcan a esa company.
 *
 * Totales: el cliente PlacePos los pre-calcula con Big.js y los envía. El
 * service los persiste tal cual — paridad con `saleOperations.createOrder`.
 *
 * PlacePos siempre crea con `ticket_type = 'ORDER'`; aceptamos el campo
 * en el DTO pero el service lo OVERRIDEA a ORDER (paridad estricta: la
 * conversión ORDER→SALE se hace al cobrar vía `POST /payments`).
 */
export class CreateSaleDto {
  @ApiProperty({
    type: [CreateSaleLineDto],
    description: 'Líneas de la venta. Al menos una.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'La venta debe contener al menos una línea' })
  @ValidateNested({ each: true })
  @Type(() => CreateSaleLineDto)
  items!: CreateSaleLineDto[];

  @ApiProperty({
    example: 102,
    description: 'Total de la venta. Σ items.total. Pre-calculado por el cliente con Big.js.',
  })
  @Type(() => Number)
  @roundToScale(2)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'total debe ser número con hasta 2 decimales' })
  @Min(0, { message: 'total debe ser >= 0' })
  total!: number;

  @ApiProperty({
    example: 74,
    description: 'Costo total de la venta. Σ items.cost * items.quantity.',
  })
  @Type(() => Number)
  @roundToScale(2)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'cost debe ser número con hasta 2 decimales' })
  @Min(0, { message: 'cost debe ser >= 0' })
  cost!: number;

  @ApiProperty({
    example: 28,
    description: 'Ganancia total de la venta. total - cost.',
  })
  @Type(() => Number)
  @roundToScale(2)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'profit debe ser número con hasta 2 decimales' })
  profit!: number;

  @ApiProperty({
    example: 27.4509,
    description: 'Margen porcentual de la venta. (profit / total) * 100. Hasta 4 decimales.',
  })
  @Type(() => Number)
  @roundToScale(4)
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'margin debe ser número con hasta 4 decimales' })
  margin!: number;

  @ApiPropertyOptional({
    example: 1,
    description: 'ID del cliente (debe pertenecer a la company). Omitir para venta mostrador.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'customer_id debe ser entero' })
  @Min(1, { message: 'customer_id debe ser >= 1' })
  customer_id?: number | null;

  @ApiPropertyOptional({
    example: 'Juan Pérez',
    description:
      'Snapshot del nombre del cliente al crear la venta. Si no viene y customer_id está, el service toma `customer.name`.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  customer_name?: string | null;

  @ApiPropertyOptional({
    enum: TicketType,
    example: TicketType.ORDER,
    description:
      'Tipo de ticket al crear. PlacePos siempre envía ORDER; el service ignora override.',
  })
  @IsOptional()
  @IsEnum(TicketType, { message: 'ticket_type inválido' })
  ticket_type?: TicketType;

  @ApiPropertyOptional({ example: 'Pago en efectivo + transferencia.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    example: '2026-06-12',
    description:
      'Fecha de vencimiento del SaleCredit cuando la venta queda a crédito (formato YYYY-MM-DD). Si no viene, se asume created_at + 30 días.',
  })
  @IsOptional()
  @IsDateString({}, { message: 'due_date debe ser una fecha válida (YYYY-MM-DD)' })
  due_date?: string;

  @ApiPropertyOptional({
    type: [CreateSalePaymentInlineDto],
    description:
      'Pagos aplicados al momento de crear la venta. Si Σ payments < total, se genera un SaleCredit (requiere customer_id). PlacePos no envía este campo al crear ORDER (los pagos van por POST /payments).',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSalePaymentInlineDto)
  payments?: CreateSalePaymentInlineDto[];
}
