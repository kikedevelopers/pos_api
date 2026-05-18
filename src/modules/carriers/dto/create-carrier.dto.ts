import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `POST /carriers`. Campos prohibidos (strippeados):
 * `company_id`, `is_archived`, `created_by*`.
 */
export class CreateCarrierDto {
  @ApiProperty({ example: 'Transportes Caracas', maxLength: 200 })
  @IsString()
  @IsNotEmpty({ message: 'El nombre del transportista es requerido' })
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: 'J-12345678-9', maxLength: 30, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  identification?: string;

  @ApiPropertyOptional({ example: '+58 212 5551234', maxLength: 30, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ example: 'contacto@transportes.com', maxLength: 255, nullable: true })
  @IsOptional()
  @IsEmail({}, { message: 'email debe ser una dirección de correo válida' })
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({
    example: 'Cobra fletes mensuales',
    maxLength: 1000,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
