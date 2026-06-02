import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * Una línea del payload de `POST /purchases`. Espeja `PurchaseLineInput` de
 * PlacePos byte-por-byte.
 *
 * Aceptamos `number` para los valores numéricos (no string) por paridad
 * estricta con PlacePos (que envía `number` desde el cliente Electron). El
 * service eleva inmediatamente a `Big.js` para preservar precisión.
 */
export class CreatePurchaseLineDto {
  @ApiProperty({
    example: 1,
    description: 'ID del producto comprado (debe pertenecer a la company).',
  })
  @Type(() => Number)
  @IsInt({ message: 'product_id debe ser entero' })
  @Min(1, { message: 'product_id debe ser >= 1' })
  product_id!: number;

  @ApiPropertyOptional({ example: 'Aceite Diana 1L' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 5, nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'packaging_id debe ser entero' })
  @Min(1, { message: 'packaging_id debe ser >= 1' })
  packaging_id?: number | null;

  @ApiPropertyOptional({ example: 'Caja x 24' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  packaging_name?: string | null;

  @ApiPropertyOptional({ example: 24, description: 'Unidades base por paquete (snapshot).' })
  @IsOptional()
  @Type(() => Number)
  // Sin tope de decimales: es un valor derivado del cliente (puede venir de
  // divisiones). Paridad con placepos (que no valida) — la columna
  // numeric(15,4) y preciseNumber() redondean al persistir.
  @IsNumber({}, { message: 'packaging_value debe ser un número' })
  @Min(0, { message: 'packaging_value debe ser >= 0' })
  packaging_value?: number | null;

  @ApiProperty({ example: 10, description: 'Cantidad de paquetes comprados. > 0.' })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'packaging_qty debe ser número con hasta 4 decimales' },
  )
  @IsPositive({ message: 'packaging_qty debe ser mayor a cero' })
  packaging_qty!: number;

  @ApiProperty({
    example: 240,
    description: 'Cantidad total en unidades base (packaging_qty * packaging_value).',
  })
  @Type(() => Number)
  // Derivado (packaging_qty * packaging_value): puede traer muchos decimales.
  // Sin tope; la columna numeric(15,4) y preciseNumber() redondean. Paridad placepos.
  @IsNumber({}, { message: 'unit_qty debe ser un número' })
  @Min(0, { message: 'unit_qty debe ser >= 0' })
  unit_qty!: number;

  @ApiProperty({ example: 1.5, description: 'Precio por unidad base.' })
  @Type(() => Number)
  // Derivado (packaging_price / packaging_value): la división produce decimales
  // periódicos. Sin tope; numeric(15,4) y preciseNumber() redondean. Paridad placepos.
  @IsNumber({}, { message: 'unit_price debe ser un número' })
  @Min(0, { message: 'unit_price debe ser >= 0' })
  unit_price!: number;

  @ApiProperty({ example: 36, description: 'Precio por paquete (caja/bulto).' })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'packaging_price debe ser número con hasta 2 decimales' },
  )
  @Min(0, { message: 'packaging_price debe ser >= 0' })
  packaging_price!: number;

  @ApiPropertyOptional({ example: 16, description: 'Porcentaje de IVA (0 a 100).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'iva_rate debe ser número con hasta 2 decimales' })
  @Min(0, { message: 'iva_rate debe ser >= 0' })
  iva_rate?: number;

  // ───────────────────────────────────────────────────────────────────────
  // Totales de línea PRE-CALCULADOS por el cliente (paridad PlacePos).
  // El cliente los manda (Big.js), pero el server los RECOMPUTA en el action
  // (packaging_qty × packaging_price, IVA, total). Se aceptan aquí solo para
  // que `forbidNonWhitelisted` no rechace el payload — se ignoran al persistir.
  // ───────────────────────────────────────────────────────────────────────

  @ApiPropertyOptional({ description: 'Subtotal de la línea (pre-calculado por el cliente).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'subtotal debe ser un número' })
  @Min(0, { message: 'subtotal debe ser >= 0' })
  subtotal?: number;

  @ApiPropertyOptional({ description: 'IVA de la línea (pre-calculado por el cliente).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'iva_amount debe ser un número' })
  @Min(0, { message: 'iva_amount debe ser >= 0' })
  iva_amount?: number;

  @ApiPropertyOptional({ description: 'Total de la línea (pre-calculado por el cliente).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'total debe ser un número' })
  @Min(0, { message: 'total debe ser >= 0' })
  total?: number;
}

/**
 * Payload de `POST /purchases`. Espejo PlacePos `CreatePurchaseBody`.
 *
 * Campos de transporte (`carrier_id`, `transport_cost`, `total_kilos`) son
 * opt-in: si no llegan, la compra se crea sin asociación a transportista.
 * Cuando `transport_cost > 0`, `carrier_id` se exige (validación en el
 * action — DTO no puede expresar dependencia cruzada con `class-validator`).
 */
export class CreatePurchaseDto {
  @ApiProperty({
    example: 1,
    description: 'ID del proveedor (debe pertenecer a la company y estar activo).',
  })
  @Type(() => Number)
  @IsInt({ message: 'supplier_id debe ser entero' })
  @Min(1, { message: 'supplier_id debe ser >= 1' })
  supplier_id!: number;

  @ApiPropertyOptional({ example: 'Pedido semanal de aceites y enlatados.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiProperty({ type: [CreatePurchaseLineDto], description: 'Líneas de la compra. Al menos una.' })
  @IsArray()
  @ArrayMinSize(1, { message: 'La compra debe contener al menos un producto' })
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseLineDto)
  lines!: CreatePurchaseLineDto[];

  @ApiPropertyOptional({
    example: 7,
    nullable: true,
    description:
      'ID del transportista. Obligatorio si `transport_cost > 0`. Se valida que pertenezca a la company.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'carrier_id debe ser entero' })
  @Min(1, { message: 'carrier_id debe ser >= 1' })
  carrier_id?: number | null;

  @ApiPropertyOptional({
    example: 25.5,
    nullable: true,
    description: 'Costo total del flete. Genera `CarrierCredit` si > 0.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'transport_cost debe ser número con hasta 2 decimales' },
  )
  @Min(0, { message: 'transport_cost debe ser >= 0' })
  transport_cost?: number | null;

  @ApiPropertyOptional({
    example: 1200.5,
    nullable: true,
    description: 'Peso total transportado en kg. Hasta 4 decimales.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'total_kilos debe ser número con hasta 4 decimales' },
  )
  @Min(0, { message: 'total_kilos debe ser >= 0' })
  total_kilos?: number | null;

  @ApiPropertyOptional({
    example: '2026-05-22T15:30:00.000Z',
    nullable: true,
    description:
      'Fecha de la factura física del proveedor (ISO 8601). NULL si la compra entra como remisión sin factura formal. Paridad placepos.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString({}, { message: 'invoice_date debe ser fecha ISO 8601' })
  invoice_date?: string | null;

  @ApiPropertyOptional({
    example: 'F-2025-00123',
    maxLength: 64,
    nullable: true,
    description:
      'Número de factura del proveedor. placepos permite duplicados intencionales (devoluciones); no aplicamos UNIQUE.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(64)
  invoice_number?: string | null;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    nullable: true,
    description:
      'UUID v4 generado por el cliente para deduplicar reintentos. Aceptado por paridad placepos; la idempotencia server-side completa está pendiente. El cliente Electron lo genera al abrir el formulario y reusa la misma llave si hace doble-click.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID(4)
  client_operation_id?: string | null;
}
