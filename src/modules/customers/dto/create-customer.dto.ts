import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PersonType } from '@/modules/customers/entities/customer.entity';

/**
 * Payload de `POST /customers`.
 *
 * Campos PROHIBIDOS desde el cliente (strippeados por `whitelist: true` del
 * `ValidationPipe` global; reforzado por el action al construir la entidad):
 *
 *   - `company_id`: el service lo asigna desde `req.user.company_id`.
 *   - `balance`: solo se muta en fases 6/8/9 (ventas, notas, pagos). El create
 *     lo inicializa a 0 ignorando cualquier valor del DTO.
 *   - `created_by`, `created_by_id`: snapshot del actor autenticado.
 *   - `is_archived`: capacidad cloud; se setea por `PUT /:id/archive`, no por
 *     create.
 *
 * Si el cliente envía cualquiera de estos campos, el ValidationPipe responde
 * 400 con `forbidNonWhitelisted: true`.
 */
export class CreateCustomerDto {
  @ApiPropertyOptional({
    enum: PersonType,
    example: PersonType.INDIVIDUAL,
    description: 'Tipo de persona. Por defecto INDIVIDUAL.',
  })
  @IsOptional()
  @IsEnum(PersonType, { message: 'person_type debe ser uno de: INDIVIDUAL, COMPANY' })
  person_type?: PersonType;

  @ApiProperty({ example: 'Juan Pérez', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: 'juan@ejemplo.com', maxLength: 255, nullable: true })
  @IsOptional()
  @IsEmail({}, { message: 'email debe ser una dirección de correo válida' })
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ example: '+58 412 1234567', maxLength: 30, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ example: 'V-12345678', maxLength: 30, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  doc_number?: string;

  @ApiPropertyOptional({ example: 'Av. Principal #123, Caracas', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;
}
