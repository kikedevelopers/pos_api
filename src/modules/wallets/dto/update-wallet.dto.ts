import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `PUT /wallets/:id`. Espeja `UpdateWalletBody` de PlacePos.
 *
 * Solo permite renombrar — `balance` no se modifica vía este endpoint
 * (cambia exclusivamente vía operaciones financieras).
 */
export class UpdateWalletDto {
  @ApiProperty({ example: 'Efectivo' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
