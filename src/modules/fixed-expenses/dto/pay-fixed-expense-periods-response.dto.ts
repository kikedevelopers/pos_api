import { ApiProperty } from '@nestjs/swagger';

import { FixedExpensePeriodResponseDto } from './fixed-expense-period-response.dto';

/**
 * Respuesta de `POST /fixed-expenses/:id/periods/pay` (§4):
 *   `{ periods: Period[], paid_total: number }`
 * donde `periods` = TODOS los cortes del gasto ya actualizados (para refrescar
 * el modal) ordenados por `period_number ASC`.
 */
export class PayFixedExpensePeriodsResponseDto {
  @ApiProperty({
    type: [FixedExpensePeriodResponseDto],
    description: 'Todos los cortes del gasto ya actualizados (orden period_number ASC).',
  })
  periods!: FixedExpensePeriodResponseDto[];

  @ApiProperty({ example: 1_500_000, description: 'Monto total efectivamente aplicado.' })
  paid_total!: number;
}
