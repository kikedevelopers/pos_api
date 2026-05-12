import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  AccountReference,
  FinancialMovement,
  MovementConcept,
  MovementType,
} from '../entities/financial-movement.entity';

/**
 * Shape de respuesta del módulo `financial-movements`. Espeja byte-a-byte
 * el payload de `financial-movements.routes.ts` de PlacePos.
 *
 *   - `amount` se devuelve como `number` (NumericTransformer + cast en
 *     PlacePos).
 *   - `created_at` como ISO 8601.
 *   - `source_id` / `destination_id` como `number | null`.
 *   - `company_id` NO se expone (irrelevante para el cliente y reduce
 *     superficie de info-leak).
 */
export class FinancialMovementResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 150.5 })
  amount!: number;

  @ApiProperty({ enum: MovementType, example: MovementType.INCOME })
  movement_type!: MovementType;

  @ApiProperty({ enum: MovementConcept, example: MovementConcept.INITIAL_BALANCE })
  concept!: MovementConcept;

  @ApiPropertyOptional({
    example: 'Saldo inicial de cuenta bancaria: Banco Mercantil',
    nullable: true,
  })
  description!: string | null;

  @ApiPropertyOptional({ example: 'bank', nullable: true })
  source_type!: AccountReference | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  source_id!: number | null;

  @ApiPropertyOptional({ example: 'wallet', nullable: true })
  destination_type!: AccountReference | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  destination_id!: number | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  reference_code!: string | null;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export function toFinancialMovementResponseDto(
  movement: FinancialMovement,
): FinancialMovementResponseDto {
  return {
    id: Number(movement.id),
    amount: Number(movement.amount),
    movement_type: movement.movement_type,
    concept: movement.concept,
    description: movement.description,
    source_type: movement.source_type,
    source_id: movement.source_id !== null ? Number(movement.source_id) : null,
    destination_type: movement.destination_type,
    destination_id: movement.destination_id !== null ? Number(movement.destination_id) : null,
    reference_code: movement.reference_code,
    created_by: movement.created_by,
    created_by_id: movement.created_by_id !== null ? Number(movement.created_by_id) : null,
    created_at: movement.created_at.toISOString(),
  };
}
