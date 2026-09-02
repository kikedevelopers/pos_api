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

import { ComboComponentInputDto } from './combo-component.dto';
import { ProductPriceInputDto } from './product-price.dto';

/**
 * Payload de `POST /inventory`.
 *
 * Espejo de `CreateItemBody` en `placepos/src/main/server/routes/inventory.routes.ts`.
 *
 * Reglas:
 *   - `stock` REQUERIDO (numeric(15,4)). El cliente lo envía siempre desde
 *     el formulario de creación.
 *   - `is_purchasable`, `category_id`, `hash` opcionales — el cliente puede
 *     omitirlos en payloads simples.
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

  @ApiProperty({
    example: 10,
    description: 'Stock unitario. numeric(15,4). Requerido por el cliente.',
  })
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 },
    { message: 'stock debe ser número con hasta 4 decimales' },
  )
  @Min(0, { message: 'stock debe ser >= 0' })
  stock!: number;

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
    example: 22.16,
    nullable: true,
    description:
      'Presentaciones de peso/monto variable: cantidad en unidad base por unidad. ' +
      'Si llega sin `packaging_id`, el service resuelve (find-or-create) un empaque ' +
      'auto con este `value`. Espejo PlacePos.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 },
    { message: 'packaging_value debe ser número con hasta 4 decimales' },
  )
  @Min(0, { message: 'packaging_value debe ser >= 0' })
  packaging_value?: number;

  // NOTA: `image` NO se acepta en el payload. La imagen es un archivo que se
  // sube aparte (`POST /inventory/:id/image`) y la columna guarda la ruta del
  // objeto en el bucket, que escribe solo el servidor. Dejar que el cliente la
  // escribiera le permitiría apuntar un producto al archivo de otro tenant.

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  show_in_pos?: boolean;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description: 'Marca productos comprables desde el módulo de compras.',
  })
  @IsOptional()
  @IsBoolean()
  is_purchasable?: boolean;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    description: 'ID de categoría existente en la misma company. null para sin categoría.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'category_id debe ser entero' })
  @Min(1, { message: 'category_id debe ser >= 1' })
  category_id?: number | null;

  @ApiPropertyOptional({
    example: 'a1b2c3d4',
    nullable: true,
    maxLength: 200,
    description: 'Hash generado por el cliente. pos_api lo persiste passthrough; no lo recalcula.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  hash?: string | null;

  @ApiProperty({
    type: [ProductPriceInputDto],
    description: 'Mínimo 1 precio. PlacePos lo asume; aquí lo enforzamos.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'prices debe tener al menos 1 elemento' })
  @ValidateNested({ each: true })
  @Type(() => ProductPriceInputDto)
  prices!: ProductPriceInputDto[];

  @ApiPropertyOptional({
    type: [ComboComponentInputDto],
    description:
      'Receta del COMBO. Solo se lee cuando product_type === COMBO; para el resto de tipos ' +
      'se ignora por completo. El servidor deriva el `cost` del producto desde esta receta.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComboComponentInputDto)
  components?: ComboComponentInputDto[];
}
