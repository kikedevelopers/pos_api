import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Payload de `PATCH /superadmin/tenants/:companyId/ai-access`.
 *
 * Único interruptor: si la cuenta puede usar el asistente Place (IA). `false`
 * por defecto; se enciende manualmente por cuenta desde el panel.
 */
export class UpdateAiAccessDto {
  @ApiProperty({ example: true, description: 'Habilita/inhabilita Place (IA) para la cuenta.' })
  @IsBoolean()
  enabled!: boolean;
}
