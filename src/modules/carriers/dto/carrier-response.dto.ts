import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Carrier } from '../entities/carrier.entity';

/**
 * Shape de respuesta de un carrier en endpoints de lista — espejo PlacePos.
 *
 * `pending_balance` y `total_purchases` son agregados sobre `carrier_credits`
 * y se calculan en el query, no se almacenan en `carriers`.
 */
export class CarrierResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Transportes Caracas' })
  name!: string;

  @ApiPropertyOptional({ example: 'J-12345678-9', nullable: true })
  identification!: string | null;

  @ApiPropertyOptional({ example: '+58 212 5551234', nullable: true })
  phone!: string | null;

  @ApiPropertyOptional({ example: 'contacto@transportes.com', nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ example: 'Cobra fletes mensuales', nullable: true })
  notes!: string | null;

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiProperty({ example: 0, description: 'Suma de balances pendientes (>0).' })
  pending_balance!: number;

  @ApiProperty({ example: 0, description: 'Cantidad de compras a crédito asociadas.' })
  total_purchases!: number;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

/**
 * Resultado de `GET /carriers/analytics`.
 */
export class CarriersAnalyticsResponseDto {
  @ApiProperty({ example: 5, description: 'Carriers activos (no archivados).' })
  total_active!: number;

  @ApiProperty({ example: 1500.5, description: 'Sumatoria de balances pendientes.' })
  total_pending_debt!: number;

  @ApiProperty({ example: 250.0, description: 'Pagos a transportistas registrados hoy.' })
  total_paid_today!: number;
}

/**
 * Payload de `PUT /carriers/:id/archive`.
 */
export class ArchiveCarrierResponseDto {
  @ApiProperty({ example: true })
  archived!: true;
}

/**
 * Shape de detalle (`GET /carriers/:id`). Incluye créditos pendientes y
 * últimos 10 pagos (placeholders hasta Fase 5+).
 */
export class CarrierDetailResponseDto extends CarrierResponseDto {
  @ApiProperty({
    description: 'Créditos asociados (PENDING/PARTIAL).',
    isArray: true,
  })
  credits!: unknown[];

  @ApiProperty({ description: 'Últimos 10 pagos registrados.', isArray: true })
  recent_payments!: unknown[];
}

/**
 * Helper: convierte entidad `Carrier` + agregados al DTO público de lista.
 */
export function toCarrierResponseDto(
  carrier: Carrier,
  aggregates: { pending_balance: number; total_purchases: number },
): CarrierResponseDto {
  return {
    id: Number(carrier.id),
    name: carrier.name,
    identification: carrier.identification,
    phone: carrier.phone,
    email: carrier.email,
    notes: carrier.notes,
    is_archived: carrier.is_archived,
    pending_balance: aggregates.pending_balance,
    total_purchases: aggregates.total_purchases,
    created_at: carrier.created_at.toISOString(),
    updated_at: carrier.updated_at.toISOString(),
  };
}
