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
  // CRÍTICO: leemos el valor CRUDO desde `obj` (el objeto plano original), NO
  // desde `value`. Con `enableImplicitConversion: true` (main.ts) class-transformer
  // convierte el string 'false' del query param al booleano `true`
  // (`Boolean('false') === true`) ANTES de llegar aquí, por lo que `value` ya
  // viene corrupto. `obj.unread_only` conserva el string original 'true'/'false'.
  // Solo 'true'/'1' (o el booleano true) cuentan como verdadero; cualquier otro
  // valor → false (espejo PlacePos `parseUnreadOnly`).
  @Transform(({ obj }) => {
    const raw = (obj as { unread_only?: unknown })?.unread_only;
    if (typeof raw === 'boolean') {
      return raw;
    }
    return raw === 'true' || raw === '1';
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
