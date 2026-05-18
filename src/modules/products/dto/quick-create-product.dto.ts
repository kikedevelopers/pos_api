import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Payload de `POST /inventory/quick`. Espejo PlacePos.
 *
 * Crea un producto mínimo desde el módulo de compras:
 *   - `name` requerido (trim antes de validar empty).
 *   - `packaging_id` opcional (debe pertenecer a la company — el action
 *     valida).
 *   - `cost` > 0, numeric(15,2). El sale_price del único ProductPrice será
 *     igual al cost (profit/margin = 0).
 *
 * Bajo el contrato del cliente PlacePos, los productos creados aquí salen
 * con `is_purchasable=true`, `show_in_pos=false`, `archived=false`,
 * `product_type=SIMPLE`, `stock=0`.
 */
export class QuickCreateProductDto {
  @ApiProperty({
    example: 'Tornillos 1/4',
    minLength: 1,
    maxLength: 200,
    description: 'Nombre del producto. Trimeado antes de persistir.',
  })
  @IsString()
  @IsNotEmpty({ message: 'El nombre es requerido.' })
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Id de packaging existente en la misma company. Opcional.',
  })
  @IsOptional()
  @IsInt({ message: 'packaging_id debe ser entero.' })
  @Min(1)
  packaging_id?: number;

  @ApiProperty({
    example: 12.5,
    description: 'Costo unitario (> 0, hasta 2 decimales).',
  })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'El costo no es válido.' })
  @Min(0.01, { message: 'El costo debe ser mayor a cero.' })
  cost!: number;
}
