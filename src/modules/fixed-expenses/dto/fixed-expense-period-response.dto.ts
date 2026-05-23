import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type {
  FixedExpensePeriod,
  FixedExpensePeriodStatus,
} from '../entities/fixed-expense-period.entity';

/**
 * Shape de respuesta de los endpoints que devuelven cortes
 * (`GET /fixed-expenses/:id/periods` y `PUT /fixed-expenses/:id/periods/:periodId/pay`).
 *
 * Paridad PlacePos: serialización idéntica a `FixedExpensePeriod` con
 * timestamps en ISO y bigints a number.
 */
export class FixedExpensePeriodResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  fixed_expense_id!: number;

  @ApiProperty({ example: 1 })
  period_number!: number;

  @ApiProperty({ example: '2026-02-01T00:00:00.000Z' })
  due_at!: string;

  @ApiProperty({ example: 500 })
  amount!: number;

  @ApiProperty({ example: 'PENDING', enum: ['PENDING', 'PAID'] })
  status!: FixedExpensePeriodStatus;

  @ApiPropertyOptional({ example: 7, nullable: true })
  alert_id!: number | null;

  @ApiPropertyOptional({ example: '2026-02-05T10:00:00.000Z', nullable: true })
  paid_at!: string | null;

  @ApiPropertyOptional({ example: 12, nullable: true })
  paid_by_id!: number | null;

  @ApiPropertyOptional({
    example: 23,
    nullable: true,
    description: '`Expense` materializado al marcar el corte como PAID.',
  })
  expense_id!: number | null;

  @ApiProperty({ example: '2026-02-01T00:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-02-01T00:00:00.000Z' })
  updated_at!: string;
}

export function toFixedExpensePeriodResponseDto(
  period: FixedExpensePeriod,
): FixedExpensePeriodResponseDto {
  return {
    id: Number(period.id),
    fixed_expense_id: Number(period.fixed_expense_id),
    period_number: period.period_number,
    due_at: period.due_at.toISOString(),
    amount: Number(period.amount),
    status: period.status,
    alert_id: period.alert_id !== null ? Number(period.alert_id) : null,
    paid_at: period.paid_at ? period.paid_at.toISOString() : null,
    paid_by_id: period.paid_by_id !== null ? Number(period.paid_by_id) : null,
    expense_id: period.expense_id !== null ? Number(period.expense_id) : null,
    created_at: period.created_at.toISOString(),
    updated_at: period.updated_at.toISOString(),
  };
}
