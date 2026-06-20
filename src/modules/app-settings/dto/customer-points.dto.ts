import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, Min } from 'class-validator';

/**
 * Configuración del sistema de PUNTOS de cliente — mismo shape
 * `{ enabled, pesoBase, perBase }` que PlacePos
 * (`renderer/src/api/requests/app-settings/types.ts → CustomerPointsConfig`).
 *
 *   - `pointsForAmount(amount) = enabled ? floor(amount / pesoBase) * perBase : 0`.
 *   - Defaults: `enabled=false`, `pesoBase=1000`, `perBase=1`.
 */
export class CustomerPointsConfigDto {
  @ApiProperty({ example: false })
  enabled!: boolean;

  @ApiProperty({ example: 1000, description: 'X pesos por bloque de puntos.' })
  pesoBase!: number;

  @ApiProperty({ example: 1, description: 'Y puntos otorgados por bloque.' })
  perBase!: number;
}

/**
 * Payload de `PUT /app-settings/customer-points`. Validación espejo del
 * `customerPointsSchema` de PlacePos:
 *   - `enabled` boolean.
 *   - `pesoBase` número positivo (> 0).
 *   - `perBase` entero ≥ 1.
 */
export class UpdateCustomerPointsDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ example: 1000 })
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  pesoBase!: number;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  perBase!: number;
}
