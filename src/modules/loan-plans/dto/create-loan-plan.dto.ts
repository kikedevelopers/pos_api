import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import {
  DESCRIPTION_MAX_LENGTH,
  LOAN_PLAN_TYPES,
  LOAN_RATE_PERIODS,
  NAME_MAX_LENGTH,
  type LoanPlanType,
  type LoanRatePeriod,
} from '../internal/loan-plan-rules';

/**
 * Payload de `POST /loan-plans`. La forma se valida aquí; las reglas que
 * dependen del tipo (cuotas, días de cobro, rangos) las aplica
 * `normalizeLoanPlan`, la misma función que valida una edición.
 *
 * PROHIBIDOS desde el cliente (strippeados por `whitelist`): `company_id`,
 * `is_archived`, `created_by` / `created_by_id`.
 */
export class CreateLoanPlanDto {
  @ApiProperty({ example: 'Mensual 6 %', maxLength: NAME_MAX_LENGTH })
  @IsString()
  @MaxLength(NAME_MAX_LENGTH)
  name!: string;

  @ApiPropertyOptional({ example: 'Para clientes fijos', maxLength: DESCRIPTION_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @ApiProperty({ enum: LOAN_PLAN_TYPES, example: 'fixed_installment' })
  @IsIn(LOAN_PLAN_TYPES, { message: `plan_type debe ser uno de: ${LOAN_PLAN_TYPES.join(', ')}` })
  plan_type!: LoanPlanType;

  @ApiProperty({ example: 6, description: 'Tasa en % por periodo (0–100, hasta 4 decimales).' })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 })
  interest_rate!: number;

  @ApiProperty({ enum: LOAN_RATE_PERIODS, example: 'monthly' })
  @IsIn(LOAN_RATE_PERIODS, {
    message: `rate_period debe ser uno de: ${LOAN_RATE_PERIODS.join(', ')}`,
  })
  rate_period!: LoanRatePeriod;

  @ApiPropertyOptional({ example: 12, nullable: true, description: 'Solo cuota fija/diaria.' })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsInt()
  installments_count?: number | null;

  @ApiPropertyOptional({ example: 26, nullable: true, description: 'Solo cuota diaria.' })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsInt()
  collection_days?: number | null;
}
