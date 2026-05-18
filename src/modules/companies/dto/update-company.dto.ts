import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Payload de `PUT /companies/:companyId`. Espeja `CompanyUpdateBody` de
 * PlacePos (`companies.routes.ts`).
 *
 * Todos los campos son opcionales para soportar updates parciales. Cuando
 * `name` se envía, no puede ser vacío (PlacePos lo trimea y rechaza con 400).
 *
 * NO permite tocar `balance` (lo mueve solo FinancialMovement) ni `id`,
 * `company_id` (no existe; este recurso es la company), `created_at`,
 * `updated_at` (gestionados por TypeORM).
 */
export class UpdateCompanyDto {
  @ApiPropertyOptional({ example: 'Mi Negocio C.A.' })
  @IsOptional()
  @IsString({ message: 'name debe ser un texto' })
  @IsNotEmpty({ message: 'El nombre del negocio es obligatorio' })
  name?: string;

  @ApiPropertyOptional({ example: 'J-12345678-9', nullable: true })
  @IsOptional()
  @IsString({ message: 'document_number debe ser un texto' })
  document_number?: string;

  @ApiPropertyOptional({ example: 'Av. Principal, Edif. Plaza, Piso 1', nullable: true })
  @IsOptional()
  @IsString({ message: 'address debe ser un texto' })
  address?: string;

  @ApiPropertyOptional({ example: 'contacto@minegocio.com', nullable: true })
  @IsOptional()
  @IsEmail({}, { message: 'email debe ser una dirección de correo válida' })
  email?: string;

  @ApiPropertyOptional({ example: '+58 412-1234567', nullable: true })
  @IsOptional()
  @IsString({ message: 'phone_number debe ser un texto' })
  phone_number?: string;

  @ApiPropertyOptional({ example: 1000, minimum: 0 })
  @IsOptional()
  @IsNumber({}, { message: 'break_even_amount debe ser un número mayor o igual a 0' })
  @Min(0, { message: 'break_even_amount debe ser un número mayor o igual a 0' })
  break_even_amount?: number;

  @ApiPropertyOptional({ example: 30, minimum: 1, maximum: 30 })
  @IsOptional()
  @IsInt({ message: 'break_even_period_days debe ser un entero entre 1 y 30' })
  @Min(1, { message: 'break_even_period_days debe ser un entero entre 1 y 30' })
  @Max(30, { message: 'break_even_period_days debe ser un entero entre 1 y 30' })
  break_even_period_days?: number;
}
