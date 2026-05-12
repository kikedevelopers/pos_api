import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { TicketSetting, TicketSettingType } from '../entities/ticket-setting.entity';

/**
 * Shape de respuesta `ticket-settings`. NO se expone `company_id`.
 */
export class TicketSettingResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ enum: TicketSettingType, example: TicketSettingType.SALE })
  ticket_type!: TicketSettingType;

  @ApiProperty({ example: 0 })
  current_number!: number;

  @ApiPropertyOptional({ example: 'F', nullable: true })
  prefix!: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  suffix!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

export function toTicketSettingResponseDto(setting: TicketSetting): TicketSettingResponseDto {
  return {
    id: Number(setting.id),
    ticket_type: setting.ticket_type,
    current_number: Number(setting.current_number),
    prefix: setting.prefix,
    suffix: setting.suffix,
    created_at: setting.created_at.toISOString(),
    updated_at: setting.updated_at.toISOString(),
  };
}
