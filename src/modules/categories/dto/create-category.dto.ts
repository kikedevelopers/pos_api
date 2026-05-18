import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `POST /categories`.
 *
 * Campos PROHIBIDOS desde el cliente (strippeados por `whitelist: true`):
 *
 *   - `company_id`: asignado desde `req.user.company_id`.
 *   - `is_archived`: se setea por `PUT /:id/archive`.
 */
export class CreateCategoryDto {
  @ApiProperty({
    example: 'Bebidas',
    maxLength: 100,
    description: 'Nombre de la categoría.',
  })
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la categoría es requerido' })
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
