import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Payload de `PUT /email-alerts/:type` — enciende/apaga la alerta. */
export class UpdateEmailAlertDto {
  @ApiProperty({ example: true, description: 'true = la alerta se envía; false = no.' })
  @IsBoolean()
  enabled!: boolean;
}
