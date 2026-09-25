import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `POST /customer-categories`.
 *
 * Campos PROHIBIDOS desde el cliente (strippeados por `whitelist: true`):
 *
 *   - `company_id`: asignado desde `req.user.company_id`.
 *   - `is_archived`: se setea por `PUT /:id/archive`.
 *   - `created_by` / `created_by_id`: snapshot del actor autenticado.
 */
export class CreateCustomerCategoryDto {
  @ApiProperty({
    example: 'Cliente Redes Sociales',
    maxLength: 100,
    description: 'Nombre de la categoría de cliente.',
  })
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la categoría es requerido' })
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
