import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
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
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'packaging_value debe ser número con hasta 4 decimales' },
  )
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
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'unit_qty debe ser número con hasta 4 decimales' })
  @Min(0, { message: 'unit_qty debe ser >= 0' })
  unit_qty!: number;

  @ApiProperty({ example: 1.5, description: 'Precio por unidad base.' })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 4 },
    { message: 'unit_price debe ser número con hasta 4 decimales' },
  )
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
}

/**
 * Payload de `POST /purchases`. Espejo PlacePos `CreatePurchaseBody`.
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
}
