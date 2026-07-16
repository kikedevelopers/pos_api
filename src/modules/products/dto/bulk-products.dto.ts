import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { ProductType } from '@/modules/products/entities/product.entity';

/**
 * Tope máximo de items por request a `POST /inventory/bulk`. Mitiga DoS por
 * payload grande y limita el tiempo de transacción de la batch. PlacePos
 * local no enforza tope (procesa lo que llegue), pero en CLOUD es prudente.
 */
export const BULK_MAX_PER_REQUEST = 1000;

/**
 * Tope de niveles de precio por item. PlacePos soporta hasta 4 niveles
 * (Detal / Mayor / etc.). El server recalcula profit/margin con Big.js, así
 * que `profit`/`margin` que vengan en el request se IGNORAN.
 */
export const BULK_MAX_PRICES_PER_ITEM = 4;

/**
 * Input simplificado de un precio dentro de bulk. `profit`/`margin` son
 * opcionales y se IGNORAN — el server los recalcula desde `sale_price - cost`.
 */
export class BulkPriceDto {
  @ApiProperty({ example: 10.5 })
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 },
    { message: 'sale_price debe ser número con hasta 2 decimales' },
  )
  @Min(0, { message: 'sale_price debe ser >= 0' })
  sale_price!: number;

  @ApiPropertyOptional({
    example: 8,
    description: 'IGNORADO en el server. Recalculado desde sale_price - cost con Big.js.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'profit debe ser número' })
  profit?: number;

  @ApiPropertyOptional({
    example: 80,
    description: 'IGNORADO en el server. Recalculado con Big.js.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'margin debe ser número' })
  margin?: number;
}

/**
 * Empaque de una fila del bulk (columna "Empaque" del Excel, "NOMBRE - VALOR").
 * find-or-create por nombre scoped company; `value` es el factor a unidad mínima.
 *
 * Declarada ANTES de `BulkItemDto` a propósito: `emitDecoratorMetadata` emite una
 * referencia EAGER a esta clase en la propiedad `packaging?` (design:type), que
 * se evalúa al definir `BulkItemDto`. Si estuviera declarada después → TDZ
 * (ReferenceError: Cannot access 'BulkPackagingDto' before initialization).
 */
export class BulkPackagingDto {
  @ApiProperty({ example: 'MEDIA LIBRA', maxLength: 150 })
  @IsString()
  @IsNotEmpty({ message: 'El nombre del empaque no puede estar vacío' })
  @MaxLength(150)
  name!: string;

  @ApiProperty({ example: 0.5, description: 'Factor a unidad mínima. Debe ser > 0.' })
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 },
    { message: 'El valor del empaque debe ser numérico' },
  )
  @Min(0.0001, { message: 'El valor del empaque debe ser mayor que 0' })
  value!: number;
}

/**
 * Un item dentro de `POST /inventory/bulk`. Espejo de `BulkImportItem` en
 * `placepos/src/main/server/routes/inventory.routes.ts`.
 *
 * Semántica de campos opcionales (paridad PlacePos):
 *   - `category`: NOMBRE de categoría; find-or-create scoped company.
 *     `undefined`/`''` → en CREATE: sin categoría; en UPDATE: PRESERVAR.
 *   - `show_in_pos`: `undefined` → CREATE: `true`; UPDATE: PRESERVAR.
 *   - `is_purchasable`: `undefined` → CREATE: `false`; UPDATE: PRESERVAR.
 *   - `stock`: `undefined` → CREATE: `0`; UPDATE: PRESERVAR.
 *   - `cost`: `undefined` → CREATE: `0`; UPDATE: PRESERVAR (no se pisa a 0).
 */
export class BulkItemDto {
  @ApiProperty({ example: 'Coca-Cola 2L', maxLength: 150 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ example: 'SKU-12345', maxLength: 50, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sku_code?: string;

  @ApiPropertyOptional({ example: '7591001234567', maxLength: 50, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  bar_code?: string;

  @ApiPropertyOptional({
    example: 'Bebidas',
    maxLength: 150,
    description:
      'NOMBRE de categoría (no id). find-or-create scoped company. ' +
      'undefined/"" → CREATE: sin categoría; UPDATE: preservar la actual.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  category?: string;

  @ApiPropertyOptional({
    example: 'Botella retornable de 2 litros',
    description:
      'Descripción libre del producto (columna text). ' +
      'undefined/"" → CREATE: sin descripción; UPDATE: preservar la actual.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: 10,
    description: 'Stock unitario. numeric(15,4). undefined → CREATE: 0; UPDATE: preservar.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 },
    { message: 'stock debe ser número con hasta 4 decimales' },
  )
  @Min(0, { message: 'stock debe ser >= 0' })
  stock?: number;

  @ApiPropertyOptional({ example: 2.5, description: 'Costo unitario. undefined → 0.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 },
    { message: 'cost debe ser número con hasta 2 decimales' },
  )
  @Min(0, { message: 'cost debe ser >= 0' })
  cost?: number;

  @ApiPropertyOptional({
    example: ProductType.SIMPLE,
    enum: ProductType,
    default: ProductType.SIMPLE,
  })
  @IsOptional()
  @IsEnum(ProductType, { message: 'product_type debe ser SIMPLE o COMBO' })
  product_type?: ProductType;

  @ApiPropertyOptional({
    example: true,
    description: 'undefined → CREATE: true; UPDATE: preservar.',
  })
  @IsOptional()
  @IsBoolean()
  show_in_pos?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'undefined → CREATE: false; UPDATE: preservar.',
  })
  @IsOptional()
  @IsBoolean()
  is_purchasable?: boolean;

  @ApiPropertyOptional({
    type: [BulkPriceDto],
    description: `Hasta ${BULK_MAX_PRICES_PER_ITEM} niveles.`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BULK_MAX_PRICES_PER_ITEM, {
    message: `prices no puede exceder ${BULK_MAX_PRICES_PER_ITEM} niveles`,
  })
  @ValidateNested({ each: true })
  @Type(() => BulkPriceDto)
  prices?: BulkPriceDto[];

  // ── Jerarquía base/presentación (columnas "Base" y "Empaque" del Excel) ──
  @ApiPropertyOptional({
    example: 'Linaza x libra',
    maxLength: 150,
    description:
      'NOMBRE del producto BASE al que se ancla esta fila. undefined = columna ' +
      '"Base" ausente (preservar jerarquía). "" = la fila es un BASE (parent NULL). ' +
      'Con valor = la fila es una PRESENTACIÓN anclada al base con ese nombre.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  base_name?: string;

  @ApiPropertyOptional({
    type: () => BulkPackagingDto,
    description:
      'Empaque parseado de la columna "Empaque" (NOMBRE - VALOR). find-or-create ' +
      'por nombre. undefined = columna ausente.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkPackagingDto)
  packaging?: BulkPackagingDto;
}

/**
 * Payload de `POST /inventory/bulk`. Espejo PlacePos (`inventory.routes.ts`).
 *
 * Comportamiento del endpoint (por item, scoped company_id del tenant):
 *   - `tieneCodigo = !!(sku_code?.trim() || bar_code?.trim())`.
 *   - Si `tieneCodigo` → busca existing por `(sku_code = sku) OR
 *     (bar_code = bc)` dentro de la company. Existe → UPDATE; no → CREATE.
 *   - Si NO `tieneCodigo` → CREATE.
 *   - CREATE sin precios válidos → conflict 'No tiene precios válidos.'.
 *   - Response: `{ created, updated, skipped, conflicts[] }`.
 */
export class BulkProductsDto {
  @ApiProperty({
    type: [BulkItemDto],
    description: `Lista de items a procesar (máx ${BULK_MAX_PER_REQUEST}).`,
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'items debe tener al menos 1 elemento' })
  @ArrayMaxSize(BULK_MAX_PER_REQUEST, {
    message: `items no puede exceder ${BULK_MAX_PER_REQUEST} elementos`,
  })
  @ValidateNested({ each: true })
  @Type(() => BulkItemDto)
  items!: BulkItemDto[];
}

/**
 * Reporte por item conflictivo.
 */
export class BulkConflictReportDto {
  @ApiProperty({ example: 'Coca-Cola 2L' })
  name!: string;

  @ApiProperty({ example: 'No tiene precios válidos.' })
  reason!: string;
}

/**
 * Response shape de `POST /inventory/bulk`. Espejo PlacePos.
 */
export class BulkProductsResponseDto {
  @ApiProperty({ example: 3 })
  created!: number;

  @ApiProperty({ example: 5 })
  updated!: number;

  @ApiProperty({ example: 0 })
  skipped!: number;

  @ApiProperty({ type: [BulkConflictReportDto] })
  conflicts!: BulkConflictReportDto[];
}
