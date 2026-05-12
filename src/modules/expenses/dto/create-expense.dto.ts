import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { EXPENSE_CATEGORIES, type ExpenseSourceType } from '../entities/expense.entity';

/**
 * Tipos de origen aceptados al registrar un gasto. Espejo PlacePos
 * (`ExpenseSourceType`).
 */
export const EXPENSE_SOURCE_TYPES = ['bank', 'wallet', 'cash_register'] as const;

/**
 * Payload de `POST /expenses`. Espejo PlacePos `ExpensePayload` con extensión
 * de campos opcionales (category, expense_date, notes) para el cloud.
 *
 * Multi-tenancy: `company_id` NUNCA viene en el payload — se toma del JWT vía
 * `@CurrentCompany()`.
 */
export class CreateExpenseDto {
  @ApiProperty({ example: 'Pago de luz mes de Mayo', minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1, { message: 'description no puede estar vacía' })
  @MaxLength(500)
  description!: string;

  @ApiProperty({ example: 150.5, description: 'Monto del gasto. Positivo, hasta 2 decimales.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount debe ser un número con hasta 2 decimales' })
  @IsPositive({ message: 'amount debe ser mayor a cero' })
  amount!: number;

  @ApiProperty({
    enum: EXPENSE_SOURCE_TYPES,
    example: 'bank',
    description: 'Tipo de cuenta de la que se debita el gasto.',
  })
  @IsString()
  @IsIn([...EXPENSE_SOURCE_TYPES], {
    message: 'source_type inválido. Usa bank, wallet o cash_register.',
  })
  source_type!: ExpenseSourceType;

  @ApiProperty({
    example: 1,
    description: 'ID de la cuenta origen (debe pertenecer a la company).',
  })
  @Type(() => Number)
  @IsInt({ message: 'source_id debe ser entero' })
  @Min(1, { message: 'Debe seleccionarse una caja, banco o billetera.' })
  source_id!: number;

  @ApiPropertyOptional({
    enum: EXPENSE_CATEGORIES,
    example: 'UTILITIES',
    description: 'Categoría libre (forward-compatible; el frontend puede enviar otras).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({
    example: '2026-05-12T10:00:00.000Z',
    description: 'Fecha contable del gasto (ISO 8601). Default = now() en DB.',
  })
  @IsOptional()
  @IsDateString({}, { message: 'expense_date debe ser un ISO date string válido' })
  expense_date?: string;

  @ApiPropertyOptional({ example: 'Factura 12345 — pago en efectivo' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
