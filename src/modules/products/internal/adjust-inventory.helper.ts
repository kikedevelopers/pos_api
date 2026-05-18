import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Línea de inventario que entra al ajuste. `quantity` está en la unidad de
 * venta del producto (no en la unidad mínima de stock); el helper se encarga
 * de multiplicar por `packaging.value` para llevarla a la unidad base donde
 * vive `Product.stock`.
 */
export interface InventoryLineItem {
  /** Id del producto (puede ser un hijo: el delta se aplica al padre). */
  item_id: number;
  /** Cantidad vendida/devuelta en la unidad de la línea. */
  quantity: number;
  /**
   * Override opcional del `value` de packaging. Si no llega, el helper lee el
   * packaging del producto y usa su `value` (o `1` si no tiene packaging).
   */
  packaging_value?: number | null;
}

/**
 * `DEDUCT` resta del stock (al confirmar una venta). `RETURN` suma al stock
 * (al anular una venta / generar NC con devolución).
 */
export type AdjustDirection = 'DEDUCT' | 'RETURN';

const logger = new Logger('AdjustInventoryHelper');

/**
 * Ajuste de stock — espejo de `placepos/src/main/database/utils/inventoryUtils.ts`.
 *
 * Regla unificada:
 *   delta = qty × own_packaging_value
 *   target = parent_id ?? own_id
 *
 * --------------------------------------------------------------------------
 * Estado actual del API
 * --------------------------------------------------------------------------
 *
 * La tabla `products` de pos_api NO tiene aún columna `stock`/`hash`/
 * `is_purchasable` (Fase 3 las omitió, fases posteriores las añadirán). Por
 * tanto este helper es un **STUB documentado**: registra el ajuste como log
 * estructurado pero NO ejecuta UPDATE sobre `products.stock`.
 *
 * Cuando se añada la columna `stock`, el cuerpo se completa con:
 *
 *   1. `loadProductRefs(manager, itemIds)` (con lock pessimistic_write).
 *   2. `loadParentRefs(...)` para resolver targets en cascada.
 *   3. `loadPackagingValues(...)` desde `packagings.value`.
 *   4. Acumular delta = qty × packaging_value sobre target.
 *   5. `manager.increment(Product, {id: target, company_id}, 'stock', signed)`.
 *
 * La firma actual replica byte-por-byte la de PlacePos para que el llamador
 * (voidSale, editSale, processPayment) no cambie cuando la implementación
 * real aterrice.
 */
export async function adjustInventory(
  _manager: EntityManager,
  companyId: number,
  lines: InventoryLineItem[],
  direction: AdjustDirection,
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  // TODO Fase 5+: implementar el UPDATE real cuando Product.stock exista en
  // la tabla. Por ahora documentamos el intent para que reports y auditoría
  // vean que el llamador YA está pidiendo el ajuste (no es código olvidado).
  logger.log({
    event: 'inventory.adjust.stub',
    companyId,
    direction,
    lineCount: lines.length,
    items: lines.map((l) => ({
      item_id: l.item_id,
      quantity: l.quantity,
      packaging_value: l.packaging_value ?? null,
    })),
  });
}
