import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Payload de `PUT /employees/:id/profit-visibility`.
 *
 * Concede/revoca el permiso del empleado para ver márgenes y ganancias y/o sus
 * subpermisos del configurador de producto del POS (Margen / Ganancia). Patch
 * parcial: el toggle principal manda los tres (cascada del maestro), un
 * subtoggle manda solo el suyo. Debe venir al menos un campo (validado en la
 * acción). Owner-only. Paridad PlacePos.
 */
export class SetProfitVisibilityDto {
  @ApiPropertyOptional({ example: true, description: 'Permiso general de márgenes/ganancias.' })
  @IsOptional()
  @IsBoolean()
  can_view_profit?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Subpermiso: ver el margen (%) del producto en el configurador del POS.',
  })
  @IsOptional()
  @IsBoolean()
  can_view_product_margin?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Subpermiso: ver la ganancia ($) del producto en el configurador del POS.',
  })
  @IsOptional()
  @IsBoolean()
  can_view_product_profit?: boolean;
}
