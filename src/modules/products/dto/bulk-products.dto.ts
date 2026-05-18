import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
 * Input simplificado de un precio dentro de bulk. PlacePos sólo lee
 * `sale_price` aquí.
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
}

/**
 * Un item dentro de `POST /inventory/bulk`. Espejo de `BulkItem` en
 * `placepos/src/main/server/routes/inventory.routes.ts`.
 */
export class BulkItemDto {
  @ApiProperty({ example: 'Coca-Cola 2L', maxLength: 150 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ example: 2.5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 },
    { message: 'cost debe ser número con hasta 2 decimales' },
  )
  @Min(0, { message: 'cost debe ser >= 0' })
  cost?: number;

  @ApiPropertyOptional({
    example: 10,
    description: 'Stock unitario. numeric(15,4). Opcional en bulk.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 },
    { message: 'stock debe ser número con hasta 4 decimales' },
  )
  @Min(0, { message: 'stock debe ser >= 0' })
  stock?: number;

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

  @ApiPropertyOptional({ example: 'Descripción', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: ProductType.SIMPLE, enum: ProductType })
  @IsOptional()
  @IsEnum(ProductType, { message: 'product_type debe ser SIMPLE o COMBO' })
  product_type?: ProductType;

  @ApiPropertyOptional({ type: [BulkPriceDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkPriceDto)
  prices?: BulkPriceDto[];
}

/**
 * Payload de `POST /inventory/bulk`. Espejo PlacePos (`inventory.routes.ts`).
 *
 * Comportamiento del endpoint:
 *   - Por cada item, intenta hacer match por `name` dentro de la company.
 *   - Si existe y se envió `sku_code` o `bar_code` → UPDATE (replaza prices).
 *   - Si existe sin SKU/barcode → conflicto reportado (no podemos
 *     actualizar "ciegamente").
 *   - Si no existe y trae al menos un precio válido → CREATE.
 *   - Si no existe y no trae precios válidos → conflicto reportado.
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

  @ApiProperty({ example: 'Ya existe. Sin SKU/barcode no se puede actualizar.' })
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
