import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, Min } from 'class-validator';

/**
 * Tope de ids por request de clonado. Defensa contra payloads abusivos; el
 * catálogo completo se clona omitiendo `productIds` (no enviando la lista).
 */
export const CLONE_MAX_PRODUCT_IDS = 5000;

/**
 * Body de `POST /branches/:branchCompanyId/clone-products`.
 *
 *   - `productIds` omitido o vacío → clona TODO el catálogo activo del
 *     principal (todas las familias raíz).
 *   - `productIds` con ids → clona esas familias. Si un id es un HIJO, se
 *     clona su familia entera (el action sube a la raíz).
 */
export class CloneProductsDto {
  @ApiPropertyOptional({
    type: [Number],
    description:
      'Ids de productos del principal a clonar. Omitido/vacío → clona TODO el ' +
      'catálogo activo. Un id hijo clona su familia completa.',
    example: [12, 34],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CLONE_MAX_PRODUCT_IDS, {
    message: `productIds no puede exceder ${CLONE_MAX_PRODUCT_IDS} elementos`,
  })
  @Type(() => Number)
  @IsInt({ each: true, message: 'cada productId debe ser entero' })
  @Min(1, { each: true, message: 'cada productId debe ser >= 1' })
  productIds?: number[];
}

/**
 * Reporte de un producto NO clonado por colisión en la sucursal.
 */
export class CloneSkippedDto {
  name!: string;
  reason!: 'name' | 'sku' | 'barcode';
}

/**
 * Respuesta de `POST /branches/:branchCompanyId/clone-products`.
 */
export class CloneProductsResponseDto {
  created!: number;
  skipped!: CloneSkippedDto[];
}
