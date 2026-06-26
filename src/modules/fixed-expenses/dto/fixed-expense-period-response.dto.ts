import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { Expense } from '@/modules/expenses/entities/expense.entity';

import type {
  FixedExpensePeriod,
  FixedExpensePeriodStatus,
} from '../entities/fixed-expense-period.entity';

/**
 * Un abono individual (fila de `expenses` con `is_fixed = true`) aplicado a un
 * corte. Es la unidad del histórico: cuándo se pagó, quién lo registró y con qué
 * medio (caja/banco/billetera). Paridad PlacePos `PeriodPayment`.
 */
export class FixedExpensePaymentDto {
  @ApiProperty({ example: 23 })
  id!: number;

  @ApiProperty({ example: 500000, description: 'Monto del abono.' })
  amount!: number;

  @ApiProperty({ example: 'cash_register', enum: ['cash_register', 'bank', 'wallet'] })
  source_type!: string;

  @ApiPropertyOptional({ example: 'Caja de Juan', nullable: true })
  source_name!: string | null;

  @ApiPropertyOptional({ example: 'Juan Pérez', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 12, nullable: true })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-02-05T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: false, description: 'true si el abono fue anulado.' })
  is_archived!: boolean;
}

export function toFixedExpensePaymentDto(expense: Expense): FixedExpensePaymentDto {
  return {
    id: Number(expense.id),
    amount: Number(expense.amount),
    source_type: expense.source_type,
    source_name: expense.source_name ?? null,
    created_by: expense.created_by ?? null,
    created_by_id:
      expense.created_by_id !== null && expense.created_by_id !== undefined
        ? Number(expense.created_by_id)
        : null,
    created_at: expense.created_at.toISOString(),
    is_archived: expense.is_archived,
  };
}

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

  @ApiProperty({ example: 500, description: 'Monto total del corte.' })
  amount!: number;

  @ApiProperty({ example: 0, description: 'Monto acumulado pagado del corte.' })
  paid_amount!: number;

  @ApiProperty({ example: 500, description: 'Saldo restante del corte.' })
  balance!: number;

  @ApiProperty({
    example: 'PENDING',
    enum: ['PENDING', 'PARTIALLY_PAID', 'PAID'],
  })
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

  @ApiProperty({
    type: [FixedExpensePaymentDto],
    description: 'Histórico de abonos del corte (orden cronológico). Vacío si no tiene pagos.',
  })
  payments!: FixedExpensePaymentDto[];
}

export function toFixedExpensePeriodResponseDto(
  period: FixedExpensePeriod,
  payments: FixedExpensePaymentDto[] = [],
): FixedExpensePeriodResponseDto {
  return {
    id: Number(period.id),
    fixed_expense_id: Number(period.fixed_expense_id),
    period_number: period.period_number,
    due_at: period.due_at.toISOString(),
    amount: Number(period.amount),
    paid_amount: Number(period.paid_amount),
    balance: Number(period.balance),
    status: period.status,
    alert_id: period.alert_id !== null ? Number(period.alert_id) : null,
    paid_at: period.paid_at ? period.paid_at.toISOString() : null,
    paid_by_id: period.paid_by_id !== null ? Number(period.paid_by_id) : null,
    expense_id: period.expense_id !== null ? Number(period.expense_id) : null,
    created_at: period.created_at.toISOString(),
    updated_at: period.updated_at.toISOString(),
    payments,
  };
}
