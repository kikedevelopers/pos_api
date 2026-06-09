import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { AppAlert } from '../entities/app-alert.entity';

/**
 * Shape de respuesta de alertas. Espejo EXACTO del backend offline de PlacePos
 * (entidad `AppAlert`: `alert_type`, `payload` jsonb, `triggered_at`, `read_at`),
 * que es lo que consume el renderer (mismo cliente en cloud y offline). Si el
 * cloud devolviera su forma interna (`type`/`message`/`metadata`), el renderer
 * leería `alert.payload` undefined y crashearía.
 *
 * Mapeo cloud → contrato offline:
 *   - `alert_type`  ← `type`
 *   - `payload`     ← `{ ...metadata, message }` (el `message` vive dentro del
 *                     payload en offline; aquí lo inyectamos desde la columna).
 *   - `triggered_at`← `created_at` (el cloud no tiene una columna separada).
 *   - `read_at`     ← null (el cloud no rastrea timestamp de lectura; el renderer
 *                     lo tipa `string | null`).
 */
export class AppAlertResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'FIXED_EXPENSE_DUE' })
  alert_type!: string;

  @ApiProperty({
    type: Object,
    description: 'Payload tipado por `alert_type`. Incluye `message` y campos propios del tipo.',
    example: { message: 'Se cumplió un periodo de "Arriendo".', fixed_expense_id: 4 },
  })
  payload!: Record<string, unknown>;

  @ApiProperty({ example: false })
  is_read!: boolean;

  @ApiPropertyOptional({ example: null, nullable: true })
  read_at!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  triggered_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export function toAppAlertResponseDto(alert: AppAlert): AppAlertResponseDto {
  const createdAtIso = alert.created_at.toISOString();
  return {
    id: Number(alert.id),
    alert_type: alert.type,
    // El `message` siempre gana sobre cualquier clave homónima del metadata.
    payload: { ...(alert.metadata ?? {}), message: alert.message },
    is_read: alert.is_read,
    read_at: null,
    triggered_at: createdAtIso,
    created_at: createdAtIso,
  };
}

export class ListAlertsResponseDto {
  @ApiProperty({ type: [AppAlertResponseDto] })
  alerts!: AppAlertResponseDto[];

  @ApiProperty({ example: 3 })
  unread_count!: number;
}

export class UnreadCountResponseDto {
  @ApiProperty({ example: 3 })
  count!: number;
}

export class MarkAllReadResponseDto {
  @ApiProperty({ example: 5 })
  marked_count!: number;
}
