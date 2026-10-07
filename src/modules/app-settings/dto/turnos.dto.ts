import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, Max, Min } from 'class-validator';

import { TURNOS_MAX_MAX, TURNOS_MIN_MAX } from '../internal/turnos-config';

/**
 * Configuración de TURNOS de pedido (modo restaurante). Shape
 * `{ enabled, max, counter }`:
 *   - `enabled`  turnos activos (imprime el 2º ticket de turno).
 *   - `max`      tope del ciclo (1..99). Al superarlo, el contador reinicia en 1.
 *   - `counter`  último turno asignado (solo lectura: lo mueve la creación de
 *     pedidos, no la UI).
 */
export class TurnosConfigDto {
  @ApiProperty({ example: false })
  enabled!: boolean;

  @ApiProperty({ example: 99, minimum: TURNOS_MIN_MAX, maximum: TURNOS_MAX_MAX })
  max!: number;

  @ApiProperty({ example: 0, description: 'Último turno asignado (0 = ninguno).' })
  counter!: number;
}

/**
 * Payload de `PUT /app-settings/turnos`. Solo `enabled` + `max` (el contador no
 * se edita desde aquí; para reiniciarlo usa `POST /app-settings/turnos/reset`).
 */
export class UpdateTurnosDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ example: 50, minimum: TURNOS_MIN_MAX, maximum: TURNOS_MAX_MAX })
  @IsInt()
  @Min(TURNOS_MIN_MAX)
  @Max(TURNOS_MAX_MAX)
  @Type(() => Number)
  max!: number;
}
