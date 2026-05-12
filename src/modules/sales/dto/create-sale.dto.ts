import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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

import { TicketType } from '../entities/sale-invoice.entity';

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
 * Una línea del payload de `POST /sales`. Espejo PlacePos.
 */
export class CreateSaleLineDto {
  @ApiProperty({
    example: 1,
    description: 'ID del producto vendido (debe pertenecer a la company).',
  })
  @Type(() => Number)
  @IsInt({ message: 'product_id debe ser entero' })
  @Min(1, { message: 'product_id debe ser >= 1' })
  product_id!: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'ID del empaque aplicado (opcional). Debe pertenecer a la company.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'packaging_id debe ser entero' })
  @Min(1, { message: 'packaging_id debe ser >= 1' })
  packaging_id?: number | null;

  @ApiPropertyOptional({
    example: 3,
    description:
      'ID del nivel de precio aplicado (ProductPrice). Si viene, debe pertenecer al producto.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'product_price_id debe ser entero' })
  @Min(1, { message: 'product_price_id debe ser >= 1' })
  product_price_id?: number | null;

  @ApiPropertyOptional({
    example: 'Aceite Diana 1L',
    description: 'Snapshot opcional del nombre. Si no viene, se toma de product.name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiProperty({ example: 2, description: 'Cantidad vendida. > 0. Hasta 4 decimales.' })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'quantity debe ser un número con hasta 4 decimales' },
  )
  @IsPositive({ message: 'quantity debe ser mayor a cero' })
  quantity!: number;

  @ApiProperty({
    example: 25.5,
    description: 'Precio unitario al momento de la venta (snapshot). >= 0.',
  })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'unit_price debe ser un número con hasta 2 decimales' },
  )
  @Min(0, { message: 'unit_price debe ser >= 0' })
  unit_price!: number;

  @ApiPropertyOptional({
    example: 16,
    description: 'Porcentaje IVA aplicado a esta línea (0-100). Default 0.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'iva_percentage debe ser un número con hasta 4 decimales' },
  )
  @Min(0, { message: 'iva_percentage debe ser >= 0' })
  iva_percentage?: number;
}

/**
 * Payload de `POST /sales`. Espejo PlacePos `SaleInvoicePayload`.
 *
 * PlacePos siempre crea con `ticket_type = 'ORDER'`; aceptamos el campo en
 * el DTO pero el service lo OVERRIDEA a `ORDER` (paridad estricta: el
 * convert se hace vía `POST /sales/:id/convert`).
 */
export class CreateSaleDto {
  @ApiPropertyOptional({
    enum: TicketType,
    example: TicketType.ORDER,
    description:
      'Tipo de ticket al crear. PlacePos siempre envía ORDER; el service ignora override.',
  })
  @IsOptional()
  @IsEnum(TicketType, { message: 'ticket_type inválido' })
  ticket_type?: TicketType;

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

  @ApiProperty({
    type: [CreateSaleLineDto],
    description: 'Líneas de la venta. Al menos una.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'La venta debe contener al menos una línea' })
  @ValidateNested({ each: true })
  @Type(() => CreateSaleLineDto)
  lines!: CreateSaleLineDto[];

  @ApiPropertyOptional({
    type: [CreateSalePaymentInlineDto],
    description:
      'Pagos aplicados al momento de crear la venta. Si Σ payments < total, se genera un SaleCredit (requiere customer_id).',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSalePaymentInlineDto)
  payments?: CreateSalePaymentInlineDto[];
}
