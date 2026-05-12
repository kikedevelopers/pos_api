import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Sub-DTO `user` del payload de registro. Espejo de los campos del
 * `User.entity` que el cliente puede aportar; `type` y `company_id` los
 * decide el service (no se reciben del cliente para evitar elevación de
 * privilegios).
 */
export class RegisterUserDto {
  @ApiProperty({ example: 'Kike', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'Pacheco', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  lastname!: string;

  @ApiProperty({ example: 'kike@ares.pos', maxLength: 255 })
  @IsEmail({}, { message: 'email debe ser una dirección de correo válida' })
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    example: 'contrasenaSegura1!',
    minLength: 8,
    maxLength: 128,
    description: 'Texto plano. El servidor aplica argon2id antes de persistir.',
  })
  @IsString()
  @MinLength(8, { message: 'password debe tener al menos 8 caracteres' })
  @MaxLength(128, { message: 'password no puede exceder 128 caracteres' })
  password!: string;
}

/**
 * Sub-DTO `company` del payload de registro. Solo `name` es obligatorio;
 * el resto puede completarse luego desde el endpoint `PUT /companies`.
 */
export class RegisterCompanyDto {
  @ApiProperty({ example: 'Bodegón Ares', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ example: 'J-12345678-9', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  document_number?: string;

  @ApiPropertyOptional({ example: 'Caracas, Venezuela', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ example: 'contacto@ares.pos', maxLength: 255 })
  @IsOptional()
  @IsEmail({}, { message: 'company.email debe ser una dirección de correo válida' })
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ example: '+58 412 1234567', maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone_number?: string;
}

/**
 * Payload completo de `POST /auth/register`.
 *
 * Estructura idéntica a la del contrato PlacePos para mantener paridad de
 * cliente: dos sub-objetos `user` y `company`. El servicio los procesa
 * atómicamente (transacción).
 */
export class RegisterDto {
  @ApiProperty({ type: RegisterUserDto })
  @IsObject()
  @ValidateNested()
  @Type(() => RegisterUserDto)
  user!: RegisterUserDto;

  @ApiProperty({ type: RegisterCompanyDto })
  @IsObject()
  @ValidateNested()
  @Type(() => RegisterCompanyDto)
  company!: RegisterCompanyDto;
}
