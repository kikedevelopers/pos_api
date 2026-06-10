import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const emptyToUndefined = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * Payload de `POST /branches` — crea una nueva sucursal (company) para el owner
 * autenticado. Solo el nombre es obligatorio (igual que el registro); el resto
 * de datos del negocio se pueden completar luego en `PUT /companies/:id`.
 *
 * `company_id`, `is_branch`, `balance`, etc. NUNCA vienen del cliente: el
 * action los fija (`is_branch=true`, balances en 0).
 */
export class CreateBranchDto {
  @ApiProperty({ example: 'Sucursal Centro', minLength: 1, maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  company_name!: string;

  @ApiPropertyOptional({ example: '900123456-7', maxLength: 64, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  document_number?: string;

  @ApiPropertyOptional({ example: 'Calle 123 #45-67', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ example: 'sucursal@negocio.com', maxLength: 255, nullable: true })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEmail({}, { message: 'email debe ser una dirección de correo válida' })
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ example: '+57 300 1234567', maxLength: 30, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone_number?: string;
}
