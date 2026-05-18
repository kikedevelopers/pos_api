import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, Min } from 'class-validator';

/**
 * Body de `PUT /employees/:id/cash-register/base`. Fija el "fondo fijo" de la
 * caja del empleado.
 */
export class SetCashBaseDto {
  /**
   * Monto base (no negativo). Se persiste en `cash_registers.base_amount`
   * de la caja PERMANENTE del empleado (ver `employee-cash-register-lookup`
   * para la resolución por `user_id`).
   */
  @ApiProperty({ example: 50000, minimum: 0, type: 'number' })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'base_amount debe ser numérico con máximo 2 decimales' },
  )
  @Min(0, { message: 'base_amount no puede ser negativo' })
  base_amount!: number;
}
