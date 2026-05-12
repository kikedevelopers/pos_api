import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Query string de `GET /inventory`. PlacePos no usa paginación aquí
 * (devuelve TODOS los productos activos del catálogo). Replicamos esa
 * decisión por paridad — un negocio típico tiene cientos, no millones de
 * productos, y el cliente Electron necesita el set completo para
 * autocomplete.
 *
 * Extensiones opcionales (no rompen contrato, frontend PlacePos las
 * ignora):
 *   - `search`: filtro por substring en `name`, `sku_code`, `bar_code`.
 *   - `include_archived`: incluye items con `is_archived = true`.
 */
export class InventoryQueryDto {
  @ApiPropertyOptional({
    description: 'Substring case-insensitive contra name / sku_code / bar_code.',
    example: 'coca',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    description: 'Si true, incluye productos archivados.',
    default: false,
  })
  @IsOptional()
  // El query string llega como `'true'` / `'false'`. Lo coercionamos a boolean.
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  include_archived?: boolean;
}
