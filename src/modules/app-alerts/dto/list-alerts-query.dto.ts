import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query params de `GET /app-alerts`.
 *
 * Espejo PlacePos:
 *   - `unread_only` boolean (default false). Acepta 'true'/'1' como true.
 *   - `limit` integer (default 50, max 200).
 */
export class ListAlertsQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description: 'Si true, solo devuelve alertas no leídas.',
  })
  @IsOptional()
  // `@Transform` precede al `@IsBoolean` porque los query params llegan como
  // strings. Acepta 'true', '1', true como verdaderos; cualquier otro string
  // se evalúa como false (espejo PlacePos `parseUnreadOnly`).
  @Transform(({ value }) => {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return value === 'true' || value === '1';
    }
    return false;
  })
  @IsBoolean()
  unread_only?: boolean = false;

  @ApiPropertyOptional({
    type: Number,
    default: 50,
    minimum: 1,
    maximum: 200,
    description: 'Máximo número de alertas a devolver (1..200).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}
