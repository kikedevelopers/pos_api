import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsPositive, IsString, Min } from 'class-validator';

/**
 * Tipos de destino del transfer-cash. PlacePos local permite
 * `'user' | 'wallet' | 'bank'`. Cloud preserva los tres en el DTO (paridad
 * byte-por-byte del payload) y rechaza `'user'` con 422
 * `UNSUPPORTED_DESTINATION` desde el action, porque el modelo de caja en
 * cloud es por turno de company, no por usuario.
 */
export const POS_DATA_DESTINATION_TYPES = ['user', 'wallet', 'bank'] as const;
export type PosDataDestinationType = (typeof POS_DATA_DESTINATION_TYPES)[number];

/**
 * Payload de `POST /pos-data/transfer-cash`. Espejo PlacePos.
 */
export class TransferCashDto {
  @ApiProperty({ enum: POS_DATA_DESTINATION_TYPES, example: 'wallet' })
  @IsString()
  @IsIn([...POS_DATA_DESTINATION_TYPES], { message: 'destinationType inválido' })
  destinationType!: PosDataDestinationType;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  destinationId!: number;

  @ApiProperty({ example: 50, description: 'Monto a trasladar desde caja. Positivo, 2 decimales.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount debe ser un número con hasta 2 decimales' })
  @IsPositive({ message: 'amount debe ser mayor a cero' })
  amount!: number;
}
