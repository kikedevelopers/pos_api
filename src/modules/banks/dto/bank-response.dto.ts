import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Bank, BankAccountType } from '../entities/bank.entity';

/**
 * Shape de respuesta del módulo `banks`. Espeja byte-a-byte el payload de
 * `banks.routes.ts` de PlacePos:
 *
 *   - `id` se serializa como number (bigint cast).
 *   - `balance` como `number` (transformer ya hizo `Number(...)`).
 *   - `created_at` como ISO 8601.
 *
 * NO se exponen `company_id` ni `created_by_id` raw (irrelevantes para el
 * cliente PlacePos; `created_by_id` puede agregarse opt-in si un futuro
 * panel admin lo necesita).
 */
export class BankResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Banco Mercantil' })
  name!: string;

  @ApiProperty({ example: '0105-1234-56-7890123456' })
  account_number!: string;

  @ApiProperty({ enum: BankAccountType, example: BankAccountType.SAVINGS })
  account_type!: BankAccountType;

  @ApiProperty({ example: 0 })
  balance!: number;

  @ApiProperty({ example: false })
  available_in_pos!: boolean;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

export function toBankResponseDto(bank: Bank): BankResponseDto {
  return {
    id: Number(bank.id),
    name: bank.name,
    account_number: bank.account_number,
    account_type: bank.account_type,
    balance: Number(bank.balance),
    available_in_pos: bank.available_in_pos,
    created_by: bank.created_by,
    created_at: bank.created_at.toISOString(),
    updated_at: bank.updated_at.toISOString(),
  };
}
