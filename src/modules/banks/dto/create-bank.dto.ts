import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { BankAccountType } from '../entities/bank.entity';

/**
 * Payload de `POST /banks`. Espeja `CreateBankBody` de PlacePos.
 *
 *   - `name` y `account_number` son requeridos (texto libre validado por
 *     longitud).
 *   - `account_type` enum savings | checking.
 *   - `initial_balance` opcional. Si > 0, la action genera un
 *     `FinancialMovement` (concept INITIAL_BALANCE) en la misma transacción
 *     que el INSERT del bank.
 *   - `available_in_pos` controla si el bank aparece como método de pago.
 *
 * Input monetario como string (precisión: skill `financial-precision`).
 */
export class CreateBankDto {
  @ApiProperty({ example: 'Banco Mercantil', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: '0105-1234-56-7890123456', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  account_number!: string;

  @ApiProperty({ enum: BankAccountType, example: BankAccountType.SAVINGS })
  @IsEnum(BankAccountType, { message: 'account_type debe ser savings o checking' })
  account_type!: BankAccountType;

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

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  available_in_pos?: boolean;
}
