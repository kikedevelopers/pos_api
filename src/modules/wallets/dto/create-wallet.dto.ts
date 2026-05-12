import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `POST /wallets`. Espeja `CreateWalletBody` de PlacePos.
 *
 * Monto inicial como string (skill `financial-precision`).
 */
export class CreateWalletDto {
  @ApiProperty({ example: 'Efectivo', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    example: '0.00',
    description:
      'Saldo inicial en string decimal (hasta 2 decimales). Si > 0 dispara un FinancialMovement (INITIAL_BALANCE).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'initial_balance debe ser un decimal positivo con hasta 2 decimales',
  })
  initial_balance?: string;
}
