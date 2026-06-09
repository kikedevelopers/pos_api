import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  FIXED_EXPENSE_PERIOD_UNITS,
  type FixedExpensePeriodUnit,
} from '../entities/fixed-expense.entity';

/**
 * Payload de `PUT /fixed-expenses/:id`. Paridad PlacePos: el endpoint acepta
 * el mismo shape del POST y valida los mismos invariantes. Todos los campos
 * son opcionales en este DTO porque el frontend puede mandar solo lo que
 * cambia, pero el action que orquesta NO permite valores inválidos parciales.
 */
export class UpdateFixedExpenseDto {
  @ApiPropertyOptional({ example: 'Alquiler local (actualizado)', maxLength: 200 })
  @IsOptional()
  @IsString({ message: 'name debe ser texto' })
  @MinLength(1, { message: 'El nombre es obligatorio.' })
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'Pago mensual de alquiler', nullable: true })
  @IsOptional()
  @IsString({ message: 'description debe ser texto' })
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ example: 550.0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El monto debe ser un número con hasta 2 decimales.' },
  )
  @Min(0, { message: 'El monto debe ser un número mayor o igual a 0.' })
  amount?: number;

  @ApiPropertyOptional({
    enum: FIXED_EXPENSE_PERIOD_UNITS,
    example: 'month',
    description:
      'Legacy: hour/day/week/month. Calendario: semimonthly / end_of_month.',
  })
  @IsOptional()
  @IsString()
  @IsIn([...FIXED_EXPENSE_PERIOD_UNITS], {
    message: 'La unidad de periodicidad no es válida.',
  })
  period_unit?: FixedExpensePeriodUnit;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Para convenciones de calendario se ignora (se normaliza a 1).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La cantidad de periodicidad debe ser un entero positivo.' })
  @Min(1, { message: 'La cantidad de periodicidad debe ser un entero positivo.' })
  period_quantity?: number;

  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de inicio no es válida.' })
  start_date?: string;
}
