import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { AlertConfig } from '../entities/alert-config.entity';

export class AlertConfigResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'low_stock' })
  type!: string;

  @ApiProperty({ example: true })
  enabled!: boolean;

  @ApiPropertyOptional({ example: 5, nullable: true })
  threshold!: number | null;

  @ApiProperty({ type: Object, example: {} })
  config!: Record<string, unknown>;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

export function toAlertConfigResponseDto(config: AlertConfig): AlertConfigResponseDto {
  return {
    id: Number(config.id),
    type: config.type,
    enabled: config.enabled,
    threshold: config.threshold,
    config: config.config,
    created_at: config.created_at.toISOString(),
    updated_at: config.updated_at.toISOString(),
  };
}
