import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, Max, Min } from 'class-validator';

/**
 * Payload de `PATCH /superadmin/tenants/:companyId/branches`.
 *
 * Configura el gating de sucursales del owner del tenant:
 *   - `enabled`: habilita/inhabilita las sucursales de la cuenta.
 *   - `allowed`: cuántas sucursales puede crear (>= 0). La regla cruzada
 *     `enabled ⇒ allowed >= 1` la valida el action (no aquí) para no rechazar
 *     un estado intermedio legítimo.
 */
export class UpdateBranchesDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ example: 2, minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  allowed!: number;
}
