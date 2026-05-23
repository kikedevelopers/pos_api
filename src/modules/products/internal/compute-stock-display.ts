import Big from 'big.js';

/**
 * stock_display es la cantidad que la UI muestra al usuario al ver un
 * producto o presentación. Espejo EXACTO de PlacePos
 * (`database/utils/stockDisplay.ts`).
 *
 * Modelo unificado:
 *   - El stock se persiste en la unidad mínima vendible (gramos para a granel,
 *     "1" para unitarios cuyo packaging.value=1).
 *   - stock_display = stock / packaging.value. Si no hay packaging, devuelve
 *     el stock crudo.
 *   - Redondeo a 4 decimales con `roundHalfUp` alineando con `numeric(15,4)`.
 *
 * Vive en `internal/` (no se exporta fuera del módulo) porque tanto el listado
 * de inventario como los reportes deben usar EXACTAMENTE la misma fórmula —
 * cualquier divergencia rompería la coherencia entre vistas.
 */
export function computeStockDisplay(stock: number, packagingValue: number | null): number {
  if (packagingValue === null || packagingValue === undefined || packagingValue <= 0) {
    return Number(stock);
  }
  return new Big(stock).div(packagingValue).round(4, Big.roundHalfUp).toNumber();
}

/**
 * Variante para presentaciones (hijos): el stock_display deriva del stock del
 * padre y el packaging_value del hijo. Si falta cualquiera de los dos,
 * devuelve el stock crudo del hijo como fallback.
 */
export function computeChildStockDisplay(
  parentStock: number | null,
  childStock: number,
  childPackagingValue: number | null,
): number {
  if (
    parentStock === null ||
    parentStock === undefined ||
    childPackagingValue === null ||
    childPackagingValue === undefined ||
    childPackagingValue <= 0
  ) {
    return Number(childStock);
  }
  return new Big(parentStock).div(childPackagingValue).round(4, Big.roundHalfUp).toNumber();
}
