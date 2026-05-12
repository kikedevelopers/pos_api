import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { CashRegister, CashRegisterStatus } from '../entities/cash-register.entity';

/**
 * Shape de respuesta del módulo `cash-register`. NO existe analógo
 * byte-por-byte en PlacePos (PlacePos solo expone `/balance` y `/logs`).
 * Esta es una extensión del modelo cloud — los campos extra son ignorables
 * por clientes que solo lean los originales.
 */
export class CashRegisterResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiPropertyOptional({ example: 1, nullable: true })
  opened_by_user_id!: number | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  opened_by_employee_id!: number | null;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  opened_by_name!: string | null;

  @ApiProperty({ example: 0 })
  opening_balance!: number;

  @ApiPropertyOptional({ example: 150, nullable: true })
  closing_balance!: number | null;

  @ApiPropertyOptional({ example: 150, nullable: true })
  expected_balance!: number | null;

  @ApiPropertyOptional({ example: 0, nullable: true })
  difference!: number | null;

  @ApiProperty({ enum: CashRegisterStatus, example: CashRegisterStatus.OPEN })
  status!: CashRegisterStatus;

  @ApiProperty({ example: '2026-05-12T08:00:00.000Z' })
  opened_at!: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  closed_at!: string | null;
}

export function toCashRegisterResponseDto(cr: CashRegister): CashRegisterResponseDto {
  return {
    id: Number(cr.id),
    opened_by_user_id: cr.opened_by_user_id !== null ? Number(cr.opened_by_user_id) : null,
    opened_by_employee_id:
      cr.opened_by_employee_id !== null ? Number(cr.opened_by_employee_id) : null,
    opened_by_name: cr.opened_by_name,
    opening_balance: Number(cr.opening_balance),
    closing_balance: cr.closing_balance !== null ? Number(cr.closing_balance) : null,
    expected_balance: cr.expected_balance !== null ? Number(cr.expected_balance) : null,
    difference: cr.difference !== null ? Number(cr.difference) : null,
    status: cr.status,
    opened_at: cr.opened_at.toISOString(),
    closed_at: cr.closed_at ? cr.closed_at.toISOString() : null,
  };
}
