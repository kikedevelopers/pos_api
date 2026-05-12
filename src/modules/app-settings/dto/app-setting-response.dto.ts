import { ApiProperty } from '@nestjs/swagger';

import { AppSetting } from '../entities/app-setting.entity';

/**
 * Shape de respuesta `app-settings`. NO expone `company_id`.
 */
export class AppSettingResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'app_color_mode' })
  key!: string;

  @ApiProperty({ example: 'white' })
  value!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

export function toAppSettingResponseDto(setting: AppSetting): AppSettingResponseDto {
  return {
    id: Number(setting.id),
    key: setting.key,
    value: setting.value,
    created_at: setting.created_at.toISOString(),
    updated_at: setting.updated_at.toISOString(),
  };
}
