import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

/** Payload de `PATCH /superadmin/tenants/:companyId/sales-agent-access`. */
export class UpdateSalesAgentAccessDto {
  @ApiProperty({
    example: true,
    description:
      'Habilita/inhabilita el asistente de ventas de ESTA company (principal o sucursal).',
  })
  @IsBoolean()
  enabled!: boolean;
}

/** Payload de `POST /superadmin/tenants/:companyId/sales-agent/release-chat`. */
export class ReleaseSalesAgentChatDto {
  @ApiProperty({ enum: ['telegram', 'whatsapp'], example: 'whatsapp' })
  @IsIn(['telegram', 'whatsapp'])
  channel!: 'telegram' | 'whatsapp';

  @ApiProperty({ example: '573113306995@s.whatsapp.net', description: 'Chat en pausa.' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  chat_id!: string;
}
