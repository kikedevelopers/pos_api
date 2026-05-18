import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsString, MaxLength, Min } from 'class-validator';

import { MovementType } from '@/modules/financial-movements/entities/financial-movement.entity';

/**
 * Subset de `MovementType` permitido en correcciones manuales de saldo.
 *
 * El enum global incluye `TRANSFER`, que NO aplica aquí: una transferencia
 * es un par de movimientos (source/destination) y se modela vía
 * `/accounts/transfer`. Una corrección es un movimiento UNILATERAL —
 * entrada o salida — sobre una sola cuenta.
 */
export enum BankAdjustmentMovementType {
  INCOME = MovementType.INCOME,
  EXPENSE = MovementType.EXPENSE,
}

/**
 * Payload de `POST /banks/:id/adjustments`. Espejo de
 * `BankAdjustmentBody` de PlacePos.
 *
 *   - `movement_type` ∈ {INCOME, EXPENSE}.
 *   - `amount > 0` finito, hasta 2 decimales (numeric(15,2)).
 *   - `description` 1-280 chars (trimmeada antes de persistir).
 *
 * La conversión a `Big` se hace dentro del action — el DTO solo valida.
 */
export class CreateBankAdjustmentDto {
  @ApiProperty({
    enum: BankAdjustmentMovementType,
    example: BankAdjustmentMovementType.INCOME,
    description: 'INCOME suma al balance; EXPENSE resta (requiere fondos).',
  })
  @IsEnum(BankAdjustmentMovementType, {
    message: 'El tipo de movimiento debe ser INCOME o EXPENSE.',
  })
  movement_type!: BankAdjustmentMovementType;

  @ApiProperty({
    example: 100.5,
    description: 'Monto positivo (numeric(15,2)). Debe ser > 0.',
  })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El monto debe ser un número con hasta 2 decimales.' },
  )
  @Min(0.01, { message: 'El monto debe ser mayor a cero.' })
  amount!: number;

  @ApiProperty({
    example: 'Cuadre manual tras conciliación bancaria.',
    minLength: 1,
    maxLength: 280,
  })
  @IsString()
  @IsNotEmpty({ message: 'La descripción es obligatoria (máx. 280 caracteres).' })
  @MaxLength(280, { message: 'La descripción es obligatoria (máx. 280 caracteres).' })
  description!: string;
}
