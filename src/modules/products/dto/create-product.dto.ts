import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { ProductType } from '@/modules/products/entities/product.entity';

import { ProductPriceInputDto } from './product-price.dto';

/**
 * Payload de `POST /inventory`.
 *
 * Espejo de `CreateItemBody` en `placepos/src/main/server/routes/inventory.routes.ts`.
 *
 * Diferencias controladas:
 *   - Sin `stock` / `is_purchasable`: fuera del alcance de Fase 3.
 *   - `product_type` se valida con `IsEnum(ProductType)` — sólo se aceptan
 *     `'SIMPLE'` o `'COMBO'`. PlacePos acepta el string pelado; aquí
 *     forzamos el enum para detectar typos temprano.
 *   - `prices` requiere al menos 1 elemento (PlacePos lo asume implícito;
 *     aquí lo enforzamos).
 *
 * Multi-tenancy: el cliente NO envía `company_id` / `created_by`. El
 * service los resuelve desde `req.user`.
 */
export class CreateProductDto {
  @ApiProperty({ example: 'Coca-Cola 2L', maxLength: 150 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ example: 'Botella de plástico', nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    example: 2.5,
    description: 'Costo unitario. numeric(15,2).',
  })
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 },
    { message: 'cost debe ser número con hasta 2 decimales' },
  )
  @Min(0, { message: 'cost debe ser >= 0' })
  cost!: number;

  @ApiPropertyOptional({ example: 'SKU-12345', nullable: true, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sku_code?: string | null;

  @ApiPropertyOptional({ example: '7591001234567', nullable: true, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  bar_code?: string | null;

  @ApiPropertyOptional({
    example: ProductType.SIMPLE,
    enum: ProductType,
    default: ProductType.SIMPLE,
  })
  @IsOptional()
  @IsEnum(ProductType, { message: 'product_type debe ser SIMPLE o COMBO' })
  product_type?: ProductType;

  @ApiPropertyOptional({
    example: null,
    description: 'ID del producto padre (combos). null para raíz.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'parent_id debe ser entero' })
  @Min(1, { message: 'parent_id debe ser >= 1' })
  parent_id?: number | null;

  @ApiPropertyOptional({
    example: 1,
    description: 'ID del empaque asociado. null si no aplica.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'packaging_id debe ser entero' })
  @Min(1, { message: 'packaging_id debe ser >= 1' })
  packaging_id?: number | null;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/product.jpg',
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  image?: string | null;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  show_in_pos?: boolean;

  @ApiProperty({
    type: [ProductPriceInputDto],
    description: 'Mínimo 1 precio. PlacePos lo asume; aquí lo enforzamos.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'prices debe tener al menos 1 elemento' })
  @ValidateNested({ each: true })
  @Type(() => ProductPriceInputDto)
  prices!: ProductPriceInputDto[];
}
