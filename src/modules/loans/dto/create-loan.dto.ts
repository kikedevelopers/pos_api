import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { LOAN_SOURCE_TYPES, type LoanSourceType } from '../entities/loan.entity';

/** Tope de capital por préstamo: cabe en `numeric(14,2)`. */
export const MAX_LOAN_PRINCIPAL = 999_999_999_999.99;

/**
 * Payload de `POST /loans`: a quién (cliente), con qué condiciones (plan),
 * cuánto (capital), desde cuándo y de dónde sale el dinero.
 *
 * PROHIBIDOS desde el cliente (strippeados por `whitelist`): `company_id`,
 * montos calculados (cuota, pago diario), `status`, auditoría.
 */
export class CreateLoanDto {
  @ApiProperty({ example: 12 })
  @IsInt()
  @Min(1)
  customer_id!: number;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(1)
  loan_plan_id!: number;

  @ApiProperty({ example: 1000000, description: 'Capital prestado (> 0, máx 2 decimales).' })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @IsPositive({ message: 'El monto del préstamo debe ser mayor que 0' })
  @Max(MAX_LOAN_PRINCIPAL)
  principal!: number;

  @ApiPropertyOptional({ example: '2026-10-24', description: 'Inicio (YYYY-MM-DD). Por defecto hoy.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'start_date debe tener el formato YYYY-MM-DD' })
  start_date?: string;

  @ApiProperty({ enum: LOAN_SOURCE_TYPES, example: 'cash_register' })
  @IsIn(LOAN_SOURCE_TYPES, {
    message: 'source_type debe ser uno de: cash_register, bank, wallet',
  })
  source_type!: LoanSourceType;

  @ApiPropertyOptional({ example: 2, description: 'Requerido para bank/wallet; la caja es la del usuario.' })
  @ValidateIf((o: CreateLoanDto) => o.source_type === 'bank' || o.source_type === 'wallet')
  @IsInt({ message: 'source_id es requerido para banco o billetera' })
  @Min(1)
  source_id?: number;

  @ApiPropertyOptional({ example: 'Paga los viernes', maxLength: 500 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
