import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { BankAccountType } from '../entities/bank.entity';

/**
 * Payload de `PUT /banks/:id`. Espeja `UpdateBankBody` de PlacePos.
 *
 * NO permite tocar `balance` ni `is_archived`:
 *   - `balance` cambia exclusivamente vía operaciones financieras
 *     (FinancialMovement / accounts.transfer / pagos).
 *   - `is_archived` se cambia con el endpoint `DELETE /banks/:id`
 *     (archive en lugar de borrar físicamente).
 */
export class UpdateBankDto {
  @ApiProperty({ example: 'Banco Mercantil', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
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

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  available_in_pos?: boolean;
}
