import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { POS_MODES, type PosMode } from '@/common/pos-mode/pos-mode.util';

/**
 * Payload de `PATCH /superadmin/tenants/:companyId/pos-mode`.
 *
 * `IsIn` (y no `IsEnum`) porque la fuente de verdad de los modos es el arreglo
 * `POS_MODES`: sumar un modo allí lo habilita aquí sin tocar este DTO.
 */
export class UpdatePosModeDto {
  @ApiProperty({
    enum: POS_MODES,
    example: 'restaurant',
    description: 'Modo del POS del negocio: retail (POS de siempre) | restaurant (mesas/salones).',
  })
  @IsIn(POS_MODES, { message: `pos_mode debe ser uno de: ${POS_MODES.join(', ')}` })
  pos_mode!: PosMode;
}
