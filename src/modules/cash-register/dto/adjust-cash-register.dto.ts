import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Body de `POST /cash-register/adjust`. Operación administrativa del `owner`
 * para fijar el balance que DEBE tener SU PROPIA caja (la del usuario en
 * sesión). Espejo del contrato de `AdjustCashDto` (empleados), pero apuntando a
 * la caja del actor.
 */
export class AdjustCashRegisterDto {
  /**
   * Balance objetivo (no negativo). El action calcula la diferencia con el
   * balance actual y registra log + movimiento financiero por la dirección
   * correspondiente.
   */
  @ApiProperty({ example: 75000, minimum: 0, type: 'number' })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'target_balance debe ser numérico con máximo 2 decimales' },
  )
  @Min(0, { message: 'target_balance no puede ser negativo' })
  target_balance!: number;

  /**
   * Razón del ajuste — opcional, se incluye en la descripción del log y del
   * FinancialMovement. Si se omite, se usa "Ajuste administrativo".
   */
  @ApiPropertyOptional({ example: 'Conteo manual del owner', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
