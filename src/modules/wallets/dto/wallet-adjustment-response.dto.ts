import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  AccountReference,
  FinancialMovement,
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';

import { Wallet } from '../entities/wallet.entity';
import { WalletResponseDto, toWalletResponseDto } from './wallet-response.dto';

/**
 * Shape de respuesta del FinancialMovement asociado al adjustment. Espejo
 * directo del shape inline de PlacePos.
 */
export class WalletAdjustmentMovementDto {
  @ApiProperty({ example: 12 })
  id!: number;

  @ApiProperty({ example: 50.0 })
  amount!: number;

  @ApiProperty({ enum: MovementType, example: MovementType.INCOME })
  movement_type!: MovementType;

  @ApiProperty({ enum: MovementConcept, example: MovementConcept.ADJUSTMENT })
  concept!: MovementConcept;

  @ApiPropertyOptional({ example: 'Corrección de caja: conteo físico', nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  source_type!: AccountReference | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  source_id!: number | null;

  @ApiPropertyOptional({ example: 'wallet', nullable: true })
  destination_type!: AccountReference | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  destination_id!: number | null;

  @ApiPropertyOptional({ example: 'a3f1...uuid', nullable: true })
  reference_code!: string | null;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export class WalletAdjustmentResponseDto {
  @ApiProperty({ type: WalletResponseDto })
  wallet!: WalletResponseDto;

  @ApiProperty({ type: WalletAdjustmentMovementDto })
  movement!: WalletAdjustmentMovementDto;
}

export function toWalletAdjustmentMovementDto(m: FinancialMovement): WalletAdjustmentMovementDto {
  return {
    id: Number(m.id),
    amount: Number(m.amount),
    movement_type: m.movement_type,
    concept: m.concept,
    description: m.description,
    source_type: m.source_type,
    source_id: m.source_id === null ? null : Number(m.source_id),
    destination_type: m.destination_type,
    destination_id: m.destination_id === null ? null : Number(m.destination_id),
    reference_code: m.reference_code,
    created_by: m.created_by,
    created_at: m.created_at.toISOString(),
  };
}

export function toWalletAdjustmentResponseDto(
  wallet: Wallet,
  movement: FinancialMovement,
): WalletAdjustmentResponseDto {
  return {
    wallet: toWalletResponseDto(wallet),
    movement: toWalletAdjustmentMovementDto(movement),
  };
}
