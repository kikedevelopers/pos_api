import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `POST /delivery-companies` y `PUT /delivery-companies/:id`.
 *
 * Multi-tenancy: `company_id` NUNCA viene en el payload — se toma del JWT vía
 * `@CurrentCompany()`.
 *
 * `phones` se valida con máximo 4 elementos (contrato Domiciliarios). Si se
 * omite, se persiste como array vacío.
 */
export class CreateDeliveryCompanyDto {
  @ApiProperty({ example: 'Domicilios El Rápido', minLength: 1, maxLength: 120 })
  @IsString()
  @MinLength(1, { message: 'name no puede estar vacío' })
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Calle 10 #5-23, Centro', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string | null;

  @ApiProperty({
    type: [String],
    example: ['3001234567', '6012345'],
    description: 'Lista de teléfonos. Máximo 4.',
  })
  @IsArray()
  @ArrayMaxSize(4, { message: 'Máximo 4 teléfonos' })
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  phones!: string[];
}
