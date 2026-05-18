import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  CashRegisterLog,
  CashRegisterLogDirection,
  CashRegisterLogType,
} from '../entities/cash-register-log.entity';

/**
 * Espejo del shape que `cash-register.routes.ts` devuelve en `/logs` de
 * PlacePos. El payload mantiene la clave `movement_type` (PlacePos lo guarda
 * como text libre; aquí es enum).
 */
export class CashRegisterLogResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  cash_register_id!: number;

  @ApiProperty({ enum: CashRegisterLogType, example: CashRegisterLogType.CASH_RECEIVED })
  movement_type!: CashRegisterLogType;

  @ApiProperty({ example: 'IN' })
  direction!: CashRegisterLogDirection;

  @ApiProperty({ example: 50 })
  amount!: number;

  @ApiProperty({ example: true })
  affects_balance!: boolean;

  @ApiPropertyOptional({ example: 'Venta TKT-0001', nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  created_by_id!: number | null;

  @ApiPropertyOptional({ example: 100, nullable: true })
  invoice_id!: number | null;

  @ApiPropertyOptional({ example: 50, nullable: true })
  payment_id!: number | null;

  @ApiPropertyOptional({ example: 25, nullable: true })
  credit_note_id!: number | null;

  @ApiProperty({ example: false })
  is_credit_related!: boolean;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export function toCashRegisterLogResponseDto(log: CashRegisterLog): CashRegisterLogResponseDto {
  return {
    id: Number(log.id),
    cash_register_id: Number(log.cash_register_id),
    movement_type: log.type,
    direction: log.direction,
    amount: Number(log.amount),
    affects_balance: log.affects_balance,
    description: log.description,
    created_by: log.created_by,
    created_by_id: log.created_by_id !== null ? Number(log.created_by_id) : null,
    invoice_id: log.invoice_id !== null ? Number(log.invoice_id) : null,
    payment_id: log.payment_id !== null ? Number(log.payment_id) : null,
    credit_note_id: log.credit_note_id !== null ? Number(log.credit_note_id) : null,
    is_credit_related: log.is_credit_related,
    created_at: log.created_at.toISOString(),
  };
}
