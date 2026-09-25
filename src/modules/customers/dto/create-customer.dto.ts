import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Matches,
  MinLength,
} from 'class-validator';

/**
 * Normaliza campos opcionales: una cadena vacía o solo-espacios se trata como
 * AUSENTE (`undefined`). Sin esto, `@IsOptional()` no salta la validación para
 * `''` (no es null/undefined) y `@IsEmail()` rechazaría un correo vacío —
 * cuando el correo NO es obligatorio. Paridad con PlacePos, que hace
 * `email?.trim() || null` sin validar formato.
 */
const emptyToUndefined = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

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
  @Transform(emptyToUndefined)
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

  @ApiPropertyOptional({
    example: 3,
    nullable: true,
    description:
      'Ref a customer_categories (categoría ESPECIAL del cliente). Debe pertenecer a la company y estar activa. En update, `null` limpia la categoría. `@IsOptional` deja pasar null/undefined; el action valida el id contra la BD.',
  })
  @IsOptional()
  @IsInt({ message: 'category_id debe ser un entero' })
  @IsPositive({ message: 'category_id debe ser positivo' })
  category_id?: number | null;

  // --------------------------------------------------------------------------
  // Identidad fiscal (Facturación Electrónica) — opcional, solo con FE activa.
  // --------------------------------------------------------------------------
  //   Referencian catálogos de APIDIAN (los sirve `GET /fe/catalogs`). Enviar
  //   cualquiera de estos campos con valor requiere que el negocio tenga la FE
  //   habilitada AHORA (validado en el action contra la BD, no el front rancio).
  //   `type_organization_id` no se acepta: se deriva de `person_type`.

  @ApiPropertyOptional({
    example: 6,
    description: 'Ref a type_document_identifications de APIDIAN.',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  type_document_identification_id?: number;

  @ApiPropertyOptional({ example: '7', description: 'Dígito de verificación DIAN (solo NIT).' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @Matches(/^[0-9]$/, { message: 'dv debe ser un único dígito (0-9)' })
  dv?: string;

  @ApiPropertyOptional({ example: 2, description: 'Ref a type_regimes de APIDIAN.' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  type_regime_id?: number;

  @ApiPropertyOptional({ example: 117, description: 'Ref a type_liabilities de APIDIAN.' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  type_liability_id?: number;

  @ApiPropertyOptional({ example: 149, description: 'Ref a municipalities de APIDIAN.' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  municipality_id?: number;

  @ApiPropertyOptional({ example: '0000000-00', maxLength: 100, nullable: true })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(100)
  merchant_registration?: string;
}
