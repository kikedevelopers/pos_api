import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `POST /salons`.
 *
 * Campos PROHIBIDOS desde el cliente (strippeados por `whitelist: true`):
 * `company_id` (del JWT), `is_archived`, `created_by` / `created_by_id`.
 */
export class CreateSalonDto {
  @ApiProperty({ example: 'Sur A', maxLength: 100, description: 'Nombre del salón.' })
  @IsString()
  @IsNotEmpty({ message: 'El nombre del salón es requerido' })
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
