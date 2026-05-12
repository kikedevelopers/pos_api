import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Wallet } from '../entities/wallet.entity';

/**
 * Shape de respuesta del módulo `wallets`. Espeja byte-a-byte
 * `wallets.routes.ts` de PlacePos:
 *   - `id`, `name`, `balance`, `created_by`, `created_at`.
 *
 * NO se expone `company_id`.
 */
export class WalletResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Efectivo' })
  name!: string;

  @ApiProperty({ example: 0 })
  balance!: number;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export function toWalletResponseDto(wallet: Wallet): WalletResponseDto {
  return {
    id: Number(wallet.id),
    name: wallet.name,
    balance: Number(wallet.balance),
    created_by: wallet.created_by,
    created_at: wallet.created_at.toISOString(),
  };
}
