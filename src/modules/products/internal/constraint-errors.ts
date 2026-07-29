import { BadRequestException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

/**
 * Postgres SQLSTATE para `unique_violation`.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Postgres SQLSTATE para `foreign_key_violation`.
 */
export const PG_FOREIGN_KEY_VIOLATION = '23503';

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

/**
 * Traduce el `foreign_key_violation` que Postgres lanza al intentar borrar un
 * `product_prices` todavía referenciado.
 *
 * Dos FKs lo protegen con `NO ACTION`:
 *   - `sale_invoice_lines.product_price_id` → el nivel de precio ya se vendió.
 *   - `product_price_history.product_price_id` → la recepción de una compra
 *     dejó un snapshot de costo/precio apuntando a esa fila.
 *
 * Sin esta traducción el error subía crudo al filtro global y el cliente veía
 * un 500 "Error interno del servidor" opaco al guardar un producto.
 *
 * Si el match no aplica, NO re-lanza: deja al caller relanzar el original.
 */
export function translateProductPriceDeleteError(error: unknown): void {
  if (!(error instanceof QueryFailedError)) {
    return;
  }

  const pgError = error as QueryFailedError & { code?: string };

  if (pgError.code !== PG_FOREIGN_KEY_VIOLATION) {
    return;
  }

  throw new BadRequestException({
    message:
      'No se puede eliminar un nivel de precio que ya tiene ventas o historial de compras asociado. Ajusta su valor en lugar de eliminarlo.',
    payload: { code: 'PRODUCT_PRICE_IN_USE' },
  });
}
