import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNumber, Min } from 'class-validator';

/**
 * Una línea de la receta de un producto COMBO tal como la envía el cliente.
 *
 * `quantity` va SIEMPRE en la unidad MÍNIMA del componente — la misma en la que
 * vive `products.stock` (gramos, mililitros, unidades…). El servidor deriva de
 * aquí el costo del combo; el `cost` del payload se ignora para los COMBO.
 */
export class ComboComponentInputDto {
  @ApiProperty({ example: 12, description: 'Id del producto BASE que compone el combo.' })
  @Type(() => Number)
  @IsInt({ message: 'component_product_id debe ser entero' })
  @Min(1, { message: 'component_product_id debe ser >= 1' })
  component_product_id!: number;

  @ApiProperty({
    example: 25,
    description: 'Cantidad en la unidad MÍNIMA del componente. Debe ser > 0.',
  })
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 },
    { message: 'quantity debe ser número con hasta 4 decimales' },
  )
  @Min(0.0001, { message: 'quantity debe ser > 0' })
  quantity!: number;
}

/** Shape de respuesta de una línea de la receta. Espejo PlacePos. */
export class ComboComponentNestedDto {
  @ApiProperty({ example: 12 })
  component_product_id!: number;

  @ApiProperty({ example: 'MANÍ CON SAL X KILO' })
  name!: string;

  @ApiProperty({ example: 25, description: 'Cantidad en la unidad mínima del componente.' })
  quantity!: number;

  @ApiProperty({ example: 300, description: 'Aporte de esta línea al costo del combo.' })
  cost!: number;

  @ApiPropertyOptional({ example: null, nullable: true })
  packaging!: { id: number; name: string; value: number } | null;

  @ApiProperty({ example: 5000, description: 'Stock actual del componente, en unidad mínima.' })
  component_stock!: number;
}
