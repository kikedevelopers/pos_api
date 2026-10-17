import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

import { MAX_DAILY_CREDITS } from '@/modules/ai/internal/ai-credits-sql';

/**
 * Payload de `PATCH /superadmin/tenants/:companyId/ai-credits`: preguntas
 * diarias que la cuenta puede hacerle a Place. 0 = bloqueado.
 */
export class UpdateAiCreditsDto {
  @ApiProperty({ example: 5, minimum: 0, maximum: MAX_DAILY_CREDITS })
  @Type(() => Number)
  @IsInt({ message: 'Los créditos deben ser un número entero.' })
  @Min(0, { message: 'Los créditos no pueden ser negativos.' })
  @Max(MAX_DAILY_CREDITS, { message: `Máximo ${MAX_DAILY_CREDITS} créditos diarios.` })
  daily_credits!: number;
}
