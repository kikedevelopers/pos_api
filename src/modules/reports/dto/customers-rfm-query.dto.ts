import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/**
 * Query de `GET /reports/customers-rfm?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 *
 * Espejo PlacePos `reports.routes.ts:669` (params `from`, `to`, NO `dateFrom`
 * / `dateTo`). Si ambos faltan, PlacePos usa el rango `[today - 90d, today]`;
 * delegamos ese default a la action para que las divergencias horarias se
 * resuelvan en UTC (consistente con el resto del módulo).
 *
 * El rango máximo permitido (`1100` días, ~3 años) es validado dentro del
 * action porque excede el límite por defecto de `parseUtcRange` (`366`),
 * así que aquí solo aseguramos el formato.
 *
 * --------------------------------------------------------------------------
 * Paginación OPCIONAL (extensión sobre PlacePos)
 * --------------------------------------------------------------------------
 *
 * `limit` / `offset` son params NUEVOS, NO presentes en PlacePos. Razón:
 * con 50k+ clientes el payload pesa demasiado. Comportamiento:
 *
 *   - Sin `limit` y sin `offset` → response IDÉNTICO al de PlacePos (array
 *     completo). Paridad por default preservada.
 *   - Con cualquiera de los dos → response paginado
 *     `{ items, total, limit, offset }`.
 *
 * El action decide el shape según presencia/ausencia de los params.
 */
export class CustomersRfmQueryDto {
  @ApiPropertyOptional({ example: '2026-02-17' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Formato de fecha inválido (YYYY-MM-DD) en from',
  })
  from?: string;

  @ApiPropertyOptional({ example: '2026-05-18' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Formato de fecha inválido (YYYY-MM-DD) en to',
  })
  to?: string;

  @ApiPropertyOptional({
    example: 100,
    description:
      'Si se envía (junto o sin `offset`) la respuesta cambia a paginada: `{ items, total, limit, offset }`. Por defecto 100, máx 1000.',
    minimum: 1,
    maximum: 1000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser entero' })
  @Min(1, { message: 'limit debe ser >= 1' })
  @Max(1000, { message: 'limit no puede exceder 1000' })
  limit?: number;

  @ApiPropertyOptional({
    example: 0,
    description: 'Offset para paginación. Por defecto 0. Requiere/activa modo paginado.',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset debe ser entero' })
  @Min(0, { message: 'offset debe ser >= 0' })
  offset?: number;
}
