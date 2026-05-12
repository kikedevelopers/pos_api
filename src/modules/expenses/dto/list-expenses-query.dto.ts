import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBooleanString,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { EXPENSE_SOURCE_TYPES } from './create-expense.dto';
import { type ExpenseSourceType } from '../entities/expense.entity';

/**
 * Query de `GET /expenses`. Espejo PlacePos `expenses.routes.ts` (search,
 * date_from, date_to) + extensiones de cloud (category, source_type,
 * source_id, paginación opcional, includeArchived).
 *
 * Todos los filtros son opcionales. Si no se envían, devuelve los gastos
 * activos del día. Multi-tenancy: filtra siempre por `company_id` del JWT.
 */
export class ListExpensesQueryDto {
  @ApiPropertyOptional({ example: 'luz', description: 'Búsqueda libre en description (ILIKE).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ example: '2026-05-01', description: 'ISO date (YYYY-MM-DD).' })
  @IsOptional()
  @IsDateString({}, { message: 'date_from debe ser un ISO date string válido (YYYY-MM-DD)' })
  date_from?: string;

  @ApiPropertyOptional({ example: '2026-05-31', description: 'ISO date (YYYY-MM-DD).' })
  @IsOptional()
  @IsDateString({}, { message: 'date_to debe ser un ISO date string válido (YYYY-MM-DD)' })
  date_to?: string;

  @ApiPropertyOptional({ example: 'UTILITIES' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({
    enum: EXPENSE_SOURCE_TYPES,
    example: 'bank',
    description: 'Filtra por tipo de cuenta origen.',
  })
  @IsOptional()
  @IsString()
  @IsIn([...EXPENSE_SOURCE_TYPES])
  source_type?: ExpenseSourceType;

  @ApiPropertyOptional({ example: 1, description: 'ID de la cuenta origen.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  source_id?: number;

  @ApiPropertyOptional({
    example: 'false',
    description:
      'Si "true" incluye gastos anulados (is_archived=true). Default false. PlacePos los incluye siempre pero distingue por activeCount en payload — preservamos ese comportamiento por defecto.',
  })
  @IsOptional()
  @IsBooleanString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value : String(value)))
  includeArchived?: string;

  @ApiPropertyOptional({ example: 50, description: 'Tamaño de página (1..200). Default 50.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ example: 0, description: 'Offset (default 0).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
