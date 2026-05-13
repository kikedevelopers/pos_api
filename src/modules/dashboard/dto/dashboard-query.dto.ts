import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/**
 * Query base usada por endpoints que aceptan `from`/`to`. Las dates son
 * validadas con regex `YYYY-MM-DD`. La validación semántica (rango cerrado,
 * orden, máximo 366 días) ocurre en `parseDateRange` para mantener el mensaje
 * de error coincidente con PlacePos byte-por-byte.
 */
export class DashboardRangeQueryDto {
  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido (YYYY-MM-DD)' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-05-31' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido (YYYY-MM-DD)' })
  to?: string;
}

/**
 * Query del endpoint `GET /dashboard/today` y `/break-even-progress`. Solo
 * acepta `date` opcional; default = hoy UTC.
 */
export class DashboardDateQueryDto {
  @ApiPropertyOptional({ example: '2026-05-12' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido (YYYY-MM-DD)' })
  date?: string;
}

/**
 * Query del endpoint `GET /dashboard/top-products`. Acepta `limit` opcional.
 */
export class DashboardTopProductsQueryDto {
  @ApiPropertyOptional({ example: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
