import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { AlertSeverity, AppAlert } from '../entities/app-alert.entity';

export class AppAlertResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'low_stock' })
  type!: string;

  @ApiProperty({ enum: AlertSeverity, example: AlertSeverity.WARNING })
  severity!: AlertSeverity;

  @ApiProperty({ example: 'Stock bajo' })
  title!: string;

  @ApiProperty({ example: 'El producto "X" tiene stock < 5 unidades' })
  message!: string;

  @ApiProperty({ example: false })
  is_read!: boolean;

  @ApiPropertyOptional({
    type: Object,
    nullable: true,
    description: 'Payload tipado por `type`. Forma libre.',
  })
  metadata!: Record<string, unknown> | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

export function toAppAlertResponseDto(alert: AppAlert): AppAlertResponseDto {
  return {
    id: Number(alert.id),
    type: alert.type,
    severity: alert.severity,
    title: alert.title,
    message: alert.message,
    is_read: alert.is_read,
    metadata: alert.metadata,
    created_at: alert.created_at.toISOString(),
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
