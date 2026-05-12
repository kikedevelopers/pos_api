import { BadRequestException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation`.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Nombres de UNIQUEs parciales en `products`. Cada uno se traduce a un
 * `BadRequestException` con mensaje específico para que el frontend
 * (PlacePos) pueda hacer match por substring — espejo del comportamiento
 * de `mapUniqueConstraintError` en `placepos/inventory.routes.ts`.
 */
export const IDX_PRODUCT_NAME_UNIQUE = 'idx_products_company_name_unique';
export const IDX_PRODUCT_SKU_UNIQUE = 'idx_products_company_sku_unique';
export const IDX_PRODUCT_BARCODE_UNIQUE = 'idx_products_company_barcode_unique';

/**
 * Traduce errores de Postgres a `HttpException`s con mensaje legible.
 *
 * PlacePos devuelve 400 (no 409) en estos casos — replicamos para no
 * romper la lógica del cliente que branchea por status code. Si el match
 * no aplica, NO re-lanza: deja al caller relanzar el error original.
 */
export function translateProductConstraintError(error: unknown): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }

  const pgError = error as QueryFailedError & {
    code?: string;
    constraint?: string;
    detail?: string;
  };

  if (pgError.code !== PG_UNIQUE_VIOLATION) {
    return;
  }

  const constraint = pgError.constraint ?? '';
  const detail = pgError.detail ?? '';

  if (constraint === IDX_PRODUCT_NAME_UNIQUE || detail.includes('(name)')) {
    throw new BadRequestException({
      message: 'Ya existe un producto con este nombre.',
      payload: { code: 'PRODUCT_NAME_TAKEN' },
    });
  }

  if (constraint === IDX_PRODUCT_BARCODE_UNIQUE || detail.includes('bar_code')) {
    throw new BadRequestException({
      message: 'Ya existe un producto con este código de barras.',
      payload: { code: 'PRODUCT_BARCODE_TAKEN' },
    });
  }

  if (constraint === IDX_PRODUCT_SKU_UNIQUE || detail.includes('sku_code')) {
    throw new BadRequestException({
      message: 'Ya existe un producto con este código SKU.',
      payload: { code: 'PRODUCT_SKU_TAKEN' },
    });
  }

  throw new BadRequestException({
    message: 'Ya existe un producto con estos datos.',
    payload: { code: 'PRODUCT_DUPLICATE' },
  });
}
