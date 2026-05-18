import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsString, MaxLength, Min } from 'class-validator';

import { MovementType } from '@/modules/financial-movements/entities/financial-movement.entity';

/**
 * Subset de `MovementType` permitido en correcciones manuales de saldo.
 * Espejo del DTO equivalente en `banks` — `TRANSFER` queda fuera (las
 * transferencias usan `/accounts/transfer`).
 */
export enum WalletAdjustmentMovementType {
  INCOME = MovementType.INCOME,
  EXPENSE = MovementType.EXPENSE,
}

/**
 * Payload de `POST /wallets/:id/adjustments`. Espejo de
 * `WalletAdjustmentBody` de PlacePos. Mismo shape que `banks`.
 */
export class CreateWalletAdjustmentDto {
  @ApiProperty({
    enum: WalletAdjustmentMovementType,
    example: WalletAdjustmentMovementType.INCOME,
    description: 'INCOME suma al balance; EXPENSE resta (requiere fondos).',
  })
  @IsEnum(WalletAdjustmentMovementType, {
    message: 'El tipo de movimiento debe ser INCOME o EXPENSE.',
  })
  movement_type!: WalletAdjustmentMovementType;

  @ApiProperty({
    example: 50.0,
    description: 'Monto positivo (numeric(15,2)). Debe ser > 0.',
  })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El monto debe ser un número con hasta 2 decimales.' },
  )
  @Min(0.01, { message: 'El monto debe ser mayor a cero.' })
  amount!: number;

  @ApiProperty({
    example: 'Conteo físico de efectivo.',
    minLength: 1,
    maxLength: 280,
  })
  @IsString()
  @IsNotEmpty({ message: 'La descripción es obligatoria (máx. 280 caracteres).' })
  @MaxLength(280, { message: 'La descripción es obligatoria (máx. 280 caracteres).' })
  description!: string;
}
