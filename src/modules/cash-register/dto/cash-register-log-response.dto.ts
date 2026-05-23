import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  CashRegisterLog,
  CashRegisterLogDirection,
  CashRegisterLogType,
} from '../entities/cash-register-log.entity';

/**
 * Shape EXACTO que el cliente PlacePos (`cashRegisterOperations.ts →
 * getCashRegisterLogs`) devuelve al renderer en `CashLogEntry`. El renderer
 * (`CashRegisterHistoryModal.tsx`) lee las claves en camelCase (`movementType`,
 * `affectsBalance`, `createdAt`…) y NO acepta el shape snake_case interno
 * de la entidad.
 *
 * Si se devuelve snake_case, el modal pinta:
 *   - El badge "REF" en todas las filas (`!log.affectsBalance` es `true`
 *     porque `affectsBalance` queda undefined).
 *   - El concepto en blanco (`MOVEMENT_LABELS[undefined] = undefined`).
 *   - "Invalid Date" en la columna de fecha.
 *
 * Por eso convertimos al shape camelCase ANTES de salir por el controller.
 * `id`, `cashRegisterId`, `invoiceId`, `paymentId`, `creditNoteId` quedan
 * como `number` (PlacePos los devuelve así desde `Number(row.amount)` y los
 * ids enteros bigint serializados como number).
 */
export class CashRegisterLogResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  cashRegisterId!: number;

  @ApiProperty({ enum: CashRegisterLogType, example: CashRegisterLogType.CASH_RECEIVED })
  movementType!: CashRegisterLogType;

  @ApiProperty({ example: 'IN' })
  direction!: CashRegisterLogDirection;

  @ApiProperty({ example: 50 })
  amount!: number;

  @ApiProperty({ example: true })
  affectsBalance!: boolean;

  @ApiPropertyOptional({ example: 'Venta TKT-0001', nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  createdBy!: string | null;

  @ApiPropertyOptional({ example: 1, nullable: true })
  createdById!: number | null;

  @ApiPropertyOptional({ example: 100, nullable: true })
  invoiceId!: number | null;

  @ApiPropertyOptional({ example: 50, nullable: true })
  paymentId!: number | null;

  @ApiPropertyOptional({ example: 25, nullable: true })
  creditNoteId!: number | null;

  @ApiProperty({ example: false })
  isCreditRelated!: boolean;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  createdAt!: string;
}

export function toCashRegisterLogResponseDto(log: CashRegisterLog): CashRegisterLogResponseDto {
  return {
    id: Number(log.id),
    cashRegisterId: Number(log.cash_register_id),
    movementType: log.type,
    direction: log.direction,
    amount: Number(log.amount),
    affectsBalance: log.affects_balance,
    description: log.description,
    createdBy: log.created_by,
    createdById: log.created_by_id !== null ? Number(log.created_by_id) : null,
    invoiceId: log.invoice_id !== null ? Number(log.invoice_id) : null,
    paymentId: log.payment_id !== null ? Number(log.payment_id) : null,
    creditNoteId: log.credit_note_id !== null ? Number(log.credit_note_id) : null,
    isCreditRelated: log.is_credit_related,
    createdAt: log.created_at.toISOString(),
  };
}
