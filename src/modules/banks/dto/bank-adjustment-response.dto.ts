import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  AccountReference,
  FinancialMovement,
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';

import { Bank } from '../entities/bank.entity';
import { BankResponseDto, toBankResponseDto } from './bank-response.dto';

/**
 * Shape de respuesta de un FinancialMovement asociado al adjustment.
 * Espejo del shape inline que devuelve `banks.routes.ts` de PlacePos.
 *
 * NO se expone `company_id` (no aporta nada al cliente).
 */
export class BankAdjustmentMovementDto {
  @ApiProperty({ example: 12 })
  id!: number;

  @ApiProperty({ example: 100.5 })
  amount!: number;

  @ApiProperty({ enum: MovementType, example: MovementType.INCOME })
  movement_type!: MovementType;

  @ApiProperty({ enum: MovementConcept, example: MovementConcept.ADJUSTMENT })
  concept!: MovementConcept;

  @ApiPropertyOptional({ example: 'Corrección de caja: cuadre manual', nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  source_type!: AccountReference | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  source_id!: number | null;

  @ApiPropertyOptional({ example: 'bank', nullable: true })
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

/**
 * Respuesta de `POST /banks/:id/adjustments`. Devuelve el banco actualizado
 * y el movement creado, en un único payload (espejo PlacePos).
 */
export class BankAdjustmentResponseDto {
  @ApiProperty({ type: BankResponseDto })
  bank!: BankResponseDto;

  @ApiProperty({ type: BankAdjustmentMovementDto })
  movement!: BankAdjustmentMovementDto;
}

export function toBankAdjustmentMovementDto(m: FinancialMovement): BankAdjustmentMovementDto {
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

export function toBankAdjustmentResponseDto(
  bank: Bank,
  movement: FinancialMovement,
): BankAdjustmentResponseDto {
  return {
    bank: toBankResponseDto(bank),
    movement: toBankAdjustmentMovementDto(movement),
  };
}
