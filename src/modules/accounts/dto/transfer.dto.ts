import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsPositive, IsString, Min } from 'class-validator';

/**
 * Tipos válidos de origen en una transferencia. Espeja `SourceType` de
 * PlacePos: 'wallet' | 'bank'. (PlacePos no permite que `bank` o `user`
 * sean origen — el dinero "se origina" en cuentas administrativas o cajas
 * de wallet.)
 */
export const TRANSFER_SOURCE_TYPES = ['wallet', 'bank'] as const;
export type TransferSourceType = (typeof TRANSFER_SOURCE_TYPES)[number];

/**
 * Tipos válidos de destino. Espeja `DestinationType` de PlacePos:
 * 'wallet' | 'bank' | 'user'.
 *
 * En cloud `'user'` se acepta a nivel de DTO (paridad byte-por-byte del
 * payload) PERO `TransferAction` lo rechaza con `422 UNSUPPORTED_DESTINATION`
 * porque el modelo cloud no expone "caja personal por usuario" (los turnos
 * de caja están atados a `company_id`, no a `user_id`). Si en el futuro se
 * habilita per-user cash registers, basta con quitar el guard en el action.
 */
export const TRANSFER_DESTINATION_TYPES = ['wallet', 'bank', 'user'] as const;
export type TransferDestinationType = (typeof TRANSFER_DESTINATION_TYPES)[number];

/**
 * Alias retrocompatibles para el resto del módulo (helpers internos +
 * `transfer-destinations-query.dto.ts`) que solo manejan tipos de origen.
 * No introducir nuevos consumidores de estos alias en código nuevo —
 * referenciar `TransferSourceType` / `TransferDestinationType` directo.
 */
export const TRANSFER_ACCOUNT_TYPES = TRANSFER_SOURCE_TYPES;
export type TransferAccountType = TransferSourceType;

/**
 * Payload de `POST /accounts/transfer`.
 *
 * Mantiene los nombres camelCase de PlacePos (`sourceType`, `sourceId`, …)
 * para paridad byte-por-byte del payload, incluido `amount: number`. El
 * action lo eleva a `Big.js` inmediatamente para preservar precisión en los
 * cálculos.
 */
export class TransferDto {
  @ApiProperty({ enum: TRANSFER_SOURCE_TYPES, example: 'wallet' })
  @IsString()
  @IsIn([...TRANSFER_SOURCE_TYPES], { message: 'sourceType inválido' })
  sourceType!: TransferSourceType;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  sourceId!: number;

  @ApiProperty({ enum: TRANSFER_DESTINATION_TYPES, example: 'bank' })
  @IsString()
  @IsIn([...TRANSFER_DESTINATION_TYPES], { message: 'destinationType inválido' })
  destinationType!: TransferDestinationType;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  destinationId!: number;

  @ApiProperty({
    example: 50,
    description: 'Monto a transferir. Positivo, hasta 2 decimales.',
  })
  // `@Type(() => Number)` coerciona "50" → 50 si el cliente accidentalmente
  // lo envía como string; mantiene paridad con PlacePos (que espera number)
  // sin romper si un cliente legacy todavía manda string.
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount debe ser un número con hasta 2 decimales' })
  @IsPositive({ message: 'amount debe ser mayor a cero' })
  amount!: number;
}
