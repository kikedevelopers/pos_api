import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

import { POS_DATA_DESTINATION_TYPES, type PosDataDestinationType } from './transfer-cash.dto';

/**
 * Payload de `POST /pos-data/close-cash` — espejo PlacePos.
 *
 * Dos modos:
 *
 *  1. `reconcile = false` (default): el cajero indica cuánto transferir a un
 *     destino. La caja queda en `balance - amount_to_transfer`. NO concilia
 *     contra efectivo físico.
 *
 *  2. `reconcile = true`: el cajero conta el efectivo físico (`counted_amount`)
 *     y el endpoint deja la caja EXACTAMENTE en `base_amount`. Sobrante /
 *     faltante se registran como `CASH_OVERAGE` / `CASH_SHORTAGE` y el resto
 *     se mueve al destino.
 *
 * Validación cruzada (destino obligatorio cuando hay traslado, counted >= 0
 * en reconcile) se aplica desde el action porque depende del modo elegido.
 */
export class CloseCashDto {
  @ApiPropertyOptional({
    enum: POS_DATA_DESTINATION_TYPES,
    example: 'wallet',
    description:
      'Destino del traslado de efectivo. Requerido cuando `reconcile=true` o cuando `amount_to_transfer > 0`. `user` se rechaza con 422 UNSUPPORTED_DESTINATION.',
  })
  @IsOptional()
  @IsString()
  @IsIn([...POS_DATA_DESTINATION_TYPES], { message: 'destinationType inválido' })
  destinationType?: PosDataDestinationType;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  destinationId?: number;

  @ApiProperty({
    example: 100,
    description: 'Monto a trasladar (modo simple). Se ignora cuando `reconcile=true`. >= 0.',
    default: 0,
  })
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'amount_to_transfer debe ser un número con hasta 2 decimales' },
  )
  @Min(0, { message: 'amount_to_transfer inválido' })
  amount_to_transfer!: number;

  @ApiPropertyOptional({
    example: 350.5,
    description:
      'Efectivo físico contado por el cajero (modo conciliación). Obligatorio cuando `reconcile=true`. >= 0.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'counted_amount debe ser un número con hasta 2 decimales' },
  )
  @Min(0, { message: 'counted_amount inválido' })
  counted_amount?: number;

  @ApiPropertyOptional({
    example: false,
    description:
      'true => modo conciliación (deja caja en base_amount, marca sobrante/faltante). false => modo simple (solo transfiere amount_to_transfer).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  reconcile?: boolean;
}
