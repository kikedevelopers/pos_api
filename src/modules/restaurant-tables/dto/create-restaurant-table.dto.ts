import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Payload de `POST /restaurant-tables` (mesa suelta) y `POST /salons/:id/tables`
 * (mesa creada dentro de un salón).
 *
 * `salon_id` y `owned_by_salon` NO vienen del cliente: los fija el servidor
 * según la ruta usada.
 */
export class CreateRestaurantTableDto {
  @ApiProperty({ example: 'Mesa 1', maxLength: 100, description: 'Nombre o etiqueta de la mesa.' })
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la mesa es requerido' })
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 4, minimum: 1, maximum: 100, description: 'Número de sillas.' })
  @IsInt({ message: 'El número de sillas debe ser un entero' })
  @Min(1, { message: 'La mesa debe tener al menos 1 silla' })
  @Max(100)
  seats!: number;
}
