import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { FixedExpense, FixedExpensePeriodUnit } from '../entities/fixed-expense.entity';

/**
 * Stats agregados de cortes pendientes para un FixedExpense. Espejo PlacePos:
 * el listado lleva `pending_periods_count` + `pending_periods_total` por gasto
 * (calculados en una sola query con GROUP BY para evitar N+1).
 */
export interface FixedExpensePendingStats {
  count: number;
  total: number;
}

/**
 * Shape de respuesta de los endpoints `/fixed-expenses`. Espeja byte-por-byte
 * el `mapRow(...)` de PlacePos `fixed-expenses.routes.ts`, omitiendo
 * `company_id` (paridad de seguridad — el cliente no necesita el id de tenant).
 */
export class FixedExpenseResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Alquiler local' })
  name!: string;

  @ApiPropertyOptional({ example: 'Pago mensual de alquiler', nullable: true })
  description!: string | null;

  @ApiProperty({ example: 500 })
  amount!: number;

  @ApiProperty({
    example: 'month',
    enum: ['hour', 'day', 'week', 'month', 'semimonthly', 'end_of_month'],
  })
  period_unit!: FixedExpensePeriodUnit;

  @ApiProperty({ example: 1 })
  period_quantity!: number;

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z' })
  start_date!: string;

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiProperty({ example: 'Kike Pacheco' })
  created_by!: string;

  @ApiPropertyOptional({ example: 7, nullable: true })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;

  @ApiProperty({ example: 2, description: 'Cantidad de cortes con status=PENDING.' })
  pending_periods_count!: number;

  @ApiProperty({ example: 1000, description: 'Suma de amounts de cortes pendientes.' })
  pending_periods_total!: number;
}

const ZERO_STATS: FixedExpensePendingStats = { count: 0, total: 0 };

export function toFixedExpenseResponseDto(
  row: FixedExpense,
  pending: FixedExpensePendingStats = ZERO_STATS,
): FixedExpenseResponseDto {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    amount: Number(row.amount),
    period_unit: row.period_unit,
    period_quantity: row.period_quantity,
    start_date: row.start_date.toISOString(),
    is_archived: row.is_archived,
    created_by: row.created_by,
    created_by_id: row.created_by_id !== null ? Number(row.created_by_id) : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    pending_periods_count: pending.count,
    pending_periods_total: pending.total,
  };
}
