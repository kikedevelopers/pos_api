import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `POST /suppliers`.
 *
 * Campos PROHIBIDOS desde el cliente (strippeados por `whitelist: true`):
 *
 *   - `company_id`: asignado desde `req.user.company_id`.
 *   - `accumulated_debt`, `credit_balance`: mutación SOLO en fases 8 y 9
 *     (purchases y purchase_payments). El create los inicializa a 0.
 *   - `created_by`, `created_by_id`: snapshot del actor autenticado.
 *   - `is_archived`: se setea por `PUT /:id/archive`, no por create.
 *
 * Nombres byte-por-byte con PlacePos: `legal_name`, `broker`, `doc_number`.
 */
export class CreateSupplierDto {
  @ApiProperty({
    example: 'Distribuidora Caracas C.A.',
    maxLength: 200,
    description: 'Razón social del proveedor.',
  })
  @IsString()
  @IsNotEmpty({ message: 'La razón social es requerida' })
  @MinLength(1)
  @MaxLength(200)
  legal_name!: string;

  @ApiPropertyOptional({
    example: 'María García',
    maxLength: 200,
    nullable: true,
    description: 'Representante o contacto comercial del proveedor.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  broker?: string;

  @ApiPropertyOptional({ example: 'Av. Bolívar #45, Caracas', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ example: '+58 212 5551234', maxLength: 30, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ example: 'J-12345678-9', maxLength: 30, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  doc_number?: string;

  @ApiPropertyOptional({ example: 'contacto@distcaracas.com', maxLength: 255, nullable: true })
  @IsOptional()
  @IsEmail({}, { message: 'email debe ser una dirección de correo válida' })
  @MaxLength(255)
  email?: string;
}
