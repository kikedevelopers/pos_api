import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import type { ImportTenantCustomersResult } from '../actions/import-tenant-customers.action';

/**
 * Tope de filas por importación. Protege contra un payload abusivo; una lista
 * de clientes real está muy por debajo.
 */
const MAX_ROWS = 50_000;

/**
 * Una fila cruda del CSV. TODO es opcional y laxo a propósito: el CSV puede
 * traer celdas vacías o filas sin nombre, y la ACTION decide qué hacer
 * (saltar inválidas, deduplicar). Validar aquí con reglas duras haría fallar
 * toda la carga por una sola fila mala.
 */
export class ImportCustomerRowDto {
  @ApiPropertyOptional({ enum: ['INDIVIDUAL', 'COMPANY'] })
  @IsOptional()
  @IsString()
  @IsIn(['INDIVIDUAL', 'COMPANY', ''])
  person_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  doc_number?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  category?: string;
}

export class ImportTenantCustomersDto {
  @ApiProperty({ type: [ImportCustomerRowDto] })
  @IsArray()
  @ArrayMaxSize(MAX_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ImportCustomerRowDto)
  customers!: ImportCustomerRowDto[];
}

/** Resultado de la importación de clientes (panel superadmin). */
export class SuperadminImportCustomersResponseDto {
  @ApiProperty({ description: 'Clientes insertados en el destino' })
  inserted!: number;

  @ApiProperty({ description: 'Omitidos por existir ya (dedup por documento/nombre)' })
  skippedExisting!: number;

  @ApiProperty({ description: 'Omitidos por no tener nombre (fila inválida)' })
  skippedInvalid!: number;

  @ApiProperty({ description: 'Categorías creadas al resolverlas por nombre' })
  categoriesCreated!: number;
}

export const toSuperadminImportCustomersResponseDto = (
  result: ImportTenantCustomersResult,
): SuperadminImportCustomersResponseDto => ({ ...result });
