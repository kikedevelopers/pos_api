import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { AlertConfig } from '../entities/alert-config.entity';

/**
 * Shape de respuesta EXACTO al `AlertConfig` del cliente PlacePos
 * (`renderer/src/api/requests/alerts/types.ts`):
 *
 *   { id, alert_type, is_enabled, check_time, params,
 *     last_run_at, created_at, updated_at }
 *
 * El renderer (`InactiveCustomerCard`) lee `config.check_time` y `config.params`
 * directamente y revienta con `Cannot read 'slice' of undefined` si esos
 * campos no llegan. Mapeamos la entidad multi-tenant de pos_api (que guarda
 * `type`, `enabled`, jsonb `config`) al shape del cliente:
 *
 *   - `alert_type    ← entity.type`
 *   - `is_enabled    ← entity.enabled`
 *   - `check_time    ← entity.config.check_time` (default `'07:00:00'` si
 *                       falta — paridad seed placepos).
 *   - `params        ← entity.config` sin la key `check_time`.
 *   - `last_run_at   ← null` (la entidad de pos_api aún no tracker la
 *                       última corrida del scheduler — Fase 11).
 */
export class AlertConfigResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'INACTIVE_CUSTOMER' })
  alert_type!: string;

  @ApiProperty({ example: false })
  is_enabled!: boolean;

  @ApiProperty({
    example: '07:00:00',
    description:
      'Hora local de disparo del scheduler en formato HH:mm:ss. Se guarda dentro de `config.check_time` en la tabla.',
  })
  check_time!: string;

  @ApiProperty({
    type: Object,
    example: { inactivity_days: 15, min_purchases: 3, recurrence_window_days: 60 },
    description: 'Parámetros del evaluator. No incluye `check_time`.',
  })
  params!: Record<string, unknown>;

  @ApiPropertyOptional({ example: null, nullable: true })
  last_run_at!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

const DEFAULT_CHECK_TIME = '07:00:00';

export function toAlertConfigResponseDto(config: AlertConfig): AlertConfigResponseDto {
  const rawConfig = (config.config ?? {}) as Record<string, unknown>;
  const checkTimeValue = rawConfig.check_time;
  const checkTime =
    typeof checkTimeValue === 'string' && checkTimeValue.length > 0
      ? checkTimeValue
      : DEFAULT_CHECK_TIME;
  // Construye `params` sin la clave `check_time` (que va arriba).
  const { check_time: _ignored, ...params } = rawConfig;
  void _ignored;
  return {
    id: Number(config.id),
    alert_type: config.type,
    is_enabled: config.enabled,
    check_time: checkTime,
    params,
    last_run_at: null,
    created_at: config.created_at.toISOString(),
    updated_at: config.updated_at.toISOString(),
  };
}
