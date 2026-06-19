import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, Min } from 'class-validator';

export const SHARE_MAX_PRODUCT_IDS = 5000;

/**
 * Body de `POST /branches/:branchCompanyId/share-products`.
 *   - `productIds` omitido/vacío → comparte TODO el catálogo del principal
 *     (1 fila company-level con product_id NULL).
 *   - `productIds` con ids → 1 fila por producto (share product-level).
 */
export class ShareProductsDto {
  @ApiPropertyOptional({
    type: [Number],
    description:
      'Ids de productos del principal a compartir. Omitido/vacío → comparte TODO el catálogo.',
    example: [12, 34],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SHARE_MAX_PRODUCT_IDS, {
    message: `productIds no puede exceder ${SHARE_MAX_PRODUCT_IDS} elementos`,
  })
  @Type(() => Number)
  @IsInt({ each: true, message: 'cada productId debe ser entero' })
  @Min(1, { each: true, message: 'cada productId debe ser >= 1' })
  productIds?: number[];
}

/**
 * Body de `DELETE /branches/:branchCompanyId/shares`.
 *   - `productId` omitido → descomparte TODO (borra company-level y todos los
 *     product-level del par).
 *   - `productId` presente → descomparte ese producto. Si existía un share
 *     company-level, NO se toca (el producto sigue accesible por el global);
 *     se reporta en la respuesta.
 */
export class UnshareProductsDto {
  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'productId debe ser entero' })
  @Min(1, { message: 'productId debe ser >= 1' })
  productId?: number;
}

export class ShareProductsResponseDto {
  shared!: number;
  mode!: 'all' | 'products';
}

export class ShareListItemDto {
  id!: number;
  product_id!: number | null;
  created_at!: string;
}

export class UnshareResponseDto {
  removed!: number;
}
