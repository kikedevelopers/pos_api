import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  ValidateIf,
} from 'class-validator';

import {
  FIXED_EXPENSE_PERIOD_UNITS,
  type FixedExpensePeriodUnit,
} from '../entities/fixed-expense.entity';
import { isCalendarPeriodUnit } from '../internal/period-schedule';

/**
 * Payload de `POST /fixed-expenses`. Espejo PlacePos `FixedExpenseBody`.
 *
 * Reglas:
 *   - `name` no-vacío.
 *   - `amount >= 0` (allowed 0 — paridad PlacePos).
 *   - `period_unit` IN ('hour','day','week','month','semimonthly','end_of_month').
 *   - `period_quantity` entero positivo — SOLO obligatorio para unidades legacy.
 *     Para convenciones de calendario (`semimonthly`/`end_of_month`) se IGNORA;
 *     el action lo normaliza a 1.
 *   - `start_date` ISO 8601 válido.
 *
 * Multi-tenancy: `company_id` NUNCA viene en el payload — se toma del JWT.
 */
export class CreateFixedExpenseDto {
  @ApiProperty({ example: 'Alquiler local', minLength: 1, maxLength: 200 })
  @IsString({ message: 'name debe ser texto' })
  @MinLength(1, { message: 'El nombre es obligatorio.' })
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: 'Pago mensual de alquiler del local', nullable: true })
  @IsOptional()
  @IsString({ message: 'description debe ser texto' })
  @MaxLength(1000)
  description?: string | null;

  @ApiProperty({
    example: 500.0,
    description: 'Monto del gasto. >= 0, hasta 2 decimales.',
  })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El monto debe ser un número con hasta 2 decimales.' },
  )
  @Min(0, { message: 'El monto debe ser un número mayor o igual a 0.' })
  amount!: number;

  @ApiProperty({
    enum: FIXED_EXPENSE_PERIOD_UNITS,
    example: 'month',
    description:
      'Unidad de periodicidad. Legacy: hour/day/week/month. Calendario: ' +
      'semimonthly (Quincenal) / end_of_month (Mensual).',
  })
  @IsString()
  @IsIn([...FIXED_EXPENSE_PERIOD_UNITS], {
    message: 'La unidad de periodicidad no es válida.',
  })
  period_unit!: FixedExpensePeriodUnit;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Cantidad de unidades (>0). Obligatorio para unidades legacy. Para ' +
      'convenciones de calendario se ignora (se normaliza a 1).',
  })
  @ValidateIf((o: CreateFixedExpenseDto) => !isCalendarPeriodUnit(o.period_unit))
  @Type(() => Number)
  @IsInt({ message: 'La cantidad de periodicidad debe ser un entero positivo.' })
  @Min(1, { message: 'La cantidad de periodicidad debe ser un entero positivo.' })
  period_quantity?: number;

  @ApiProperty({
    example: '2026-01-01T00:00:00.000Z',
    description: 'Fecha de inicio (ISO 8601). El sync calcula cortes desde aquí.',
  })
  @IsDateString({}, { message: 'La fecha de inicio no es válida.' })
  start_date!: string;
}
