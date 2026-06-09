import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';

import {
  FIXED_EXPENSE_PAY_SOURCE_TYPES,
  type FixedExpensePaySource,
} from './pay-fixed-expense-period.dto';

/**
 * Payload de `POST /fixed-expenses/:id/periods/pay` — pago parcial/total
 * multi-corte (§4 del contrato `CONTRACT_fixed_expense_periods_pay.md`).
 *
 * UX: monto global + asignación automática del corte MÁS ANTIGUO al más nuevo.
 * El backend reparte `amount` sobre los `period_ids` seleccionados ordenados por
 * `period_number ASC`, pagando completos los viejos y parcial el último que
 * alcance. Todo en UNA transacción.
 *
 * Para `cash_register`, `source_id` se ignora y se resuelve la caja del actor
 * (paridad PlacePos blindaje cross-cashier).
 */
export class PayFixedExpensePeriodsDto {
  @ApiProperty({
    enum: FIXED_EXPENSE_PAY_SOURCE_TYPES,
    example: 'bank',
    description: 'Tipo de cuenta origen del pago.',
  })
  @IsString()
  @IsIn([...FIXED_EXPENSE_PAY_SOURCE_TYPES], {
    message: 'Fuente del pago inválida. Usa wallet, bank o cash_register.',
  })
  source_type!: FixedExpensePaySource;

  @ApiPropertyOptional({
    example: 5,
    description:
      'ID de la cuenta origen. Requerido para bank/wallet; ignorado para cash_register (caja del actor).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'source_id debe ser entero' })
  @Min(1, { message: 'source_id debe ser un id válido.' })
  source_id?: number;

  @ApiProperty({
    example: 1_500_000,
    description: 'Monto total a pagar (> 0). Se reparte del corte más antiguo al más nuevo.',
  })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'amount debe ser numérico con 2 decimales máximo.' },
  )
  @IsPositive({ message: 'El monto a pagar debe ser mayor que cero.' })
  amount!: number;

  @ApiProperty({
    example: [11, 12],
    description: 'IDs de los cortes seleccionados a cubrir (de este gasto).',
    type: [Number],
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Debe seleccionarse al menos un corte.' })
  @ArrayUnique({ message: 'period_ids no debe contener duplicados.' })
  @Type(() => Number)
  @IsInt({ each: true, message: 'Cada period_id debe ser entero.' })
  @Min(1, { each: true, message: 'Cada period_id debe ser un id válido.' })
  period_ids!: number[];
}
