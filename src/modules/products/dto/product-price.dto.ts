import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Input de un nivel de precio anidado dentro de `CreateProductDto` /
 * `UpdateProductDto`.
 *
 * Campos:
 *   - `id` (opcional, solo en update): si presente, el service actualiza
 *     el precio existente; si ausente, lo crea.
 *   - `name` (opcional): "Detal", "Mayor", etc. Default `""`.
 *   - `sale_price` (requerido): precio de venta.
 *   - `profit` / `margin` (opcionales): el service los RECALCULA siempre
 *     desde `sale_price - cost` con Big.js. Se aceptan en el DTO sólo por
 *     compatibilidad con PlacePos (el cliente Electron los envía y el
 *     servidor los ignora).
 *   - `iva_percentage` (opcional): porcentaje de IVA, 0 = precio final.
 */
export class ProductPriceInputDto {
  @ApiPropertyOptional({
    example: 5,
    description: 'ID del precio existente (solo en update). Si ausente, se crea.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'id debe ser entero' })
  @Min(1, { message: 'id debe ser >= 1' })
  id?: number;

  @ApiPropertyOptional({ example: 'Detal', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @ApiProperty({
    example: 10.5,
    description: 'Precio de venta. numeric(15,2).',
  })
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 },
    { message: 'sale_price debe ser número con hasta 2 decimales' },
  )
  @Min(0, { message: 'sale_price debe ser >= 0' })
  sale_price!: number;

  @ApiPropertyOptional({
    example: 3.5,
    description: 'IGNORADO en el server. Recalculado desde sale_price - cost.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 },
    { message: 'profit debe ser número con hasta 2 decimales' },
  )
  profit?: number;

  @ApiPropertyOptional({
    example: 33.3333,
    description: 'IGNORADO en el server. Recalculado.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 },
    { message: 'margin debe ser número con hasta 4 decimales' },
  )
  margin?: number;

  @ApiPropertyOptional({
    example: 0,
    description: 'Porcentaje IVA. 0 = precio final.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 },
    { message: 'iva_percentage debe ser número con hasta 4 decimales' },
  )
  @Min(0, { message: 'iva_percentage debe ser >= 0' })
  @Max(100, { message: 'iva_percentage debe ser <= 100' })
  iva_percentage?: number;
}
