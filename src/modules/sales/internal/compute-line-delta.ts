// CAMINO MUERTO: solo lo consume `generate-edit-notes.ts` (que tampoco se usa).
// El flujo VIVO de delta de edición es `calculatePlacePosLineDifferences` en
// `update-sale.action.ts`. Este `LineDifference` NO lleva `packaging_value`
// (FIX #2) a propósito: el camino real lo gestiona en el action. Si se revive,
// añadir `packaging_value` al shape y propagarlo al motor + credit_note_line.
import type Big from 'big.js';

import { preciseNumber, toBig } from '@/common/utils/precision';

import type { ComputedSaleLine } from './calculate-sale-totals';
import type { ConsolidatedLine } from './consolidate-invoice.helper';

/**
 * Diferencia de una línea — espejo PlacePos `LineDifference`.
 *
 *   - `removed`: la línea actual fue eliminada por completo del payload.
 *   - `reduced`: la cantidad bajó (delta positivo en quantity).
 *   - `added`: línea nueva (no existía en la venta actual).
 *   - `increased`: la cantidad subió (delta positivo en quantity).
 *
 * Para `removed` / `reduced` se persisten como líneas de NC `PARTIAL_VOID`
 * (devuelven dinero + retornan inventario). Para `added` / `increased` se
 * persisten como líneas de ND `ADDITION` (cobran dinero + deducen inventario).
 */
export interface LineDifference {
  type: 'removed' | 'added' | 'reduced' | 'increased';
  product_id: number;
  packaging_id: number | null;
  product_price_id: number | null;
  description: string;
  /** Costo unitario al momento de la venta original (snapshot). */
  unit_cost: number;
  /** Precio unitario al momento de la edición / venta. */
  unit_price: number;
  /** Cantidad diferencial (siempre positiva). */
  quantity: number;
  /** `unit_price * quantity_diff` (sin IVA). */
  subtotal: number;
  /** % de IVA aplicado. */
  iva_percentage: number;
  /** IVA monetario sobre el subtotal diferencial. */
  iva_amount: number;
  /** `subtotal + iva_amount`. */
  total: number;
}

/**
 * Resultado del cálculo de delta entre las líneas vivas de la venta y las
 * líneas del payload de edición.
 *
 * Importante: se compara por `product_id`. La combinación de productId con
 * packaging/price NO se incluye en la key porque PlacePos tampoco lo hace —
 * cambiar el packaging o el price de la misma línea se traduce en una
 * reducción + una adición (no en un "update").
 */
export interface LineDeltaResult {
  removedOrReduced: LineDifference[];
  addedOrIncreased: LineDifference[];
  /** `true` si no hubo cambios de líneas (no-op a efectos de NC/ND). */
  isEmpty: boolean;
}

/**
 * Calcula el delta entre el estado vivo (consolidado) y el payload editado.
 * Espejo de `calculateLineDifferences` en PlacePos `editOperations.ts`.
 *
 *   - Líneas presentes en consolidado pero no en payload → `removed`.
 *   - Líneas con `payload.quantity < consolidated.quantity` → `reduced`
 *     (diff = consolidated - payload).
 *   - Líneas presentes en payload pero no en consolidado → `added`.
 *   - Líneas con `payload.quantity > consolidated.quantity` → `increased`
 *     (diff = payload - consolidated).
 *   - Líneas con misma quantity → no aportan al delta (aunque hayan cambiado
 *     packaging/price; PlacePos las trata así).
 *
 * Toda aritmética con Big.js — `quantity` es `numeric(15,4)` y participa en
 * cálculos monetarios.
 */
export function computeLineDelta(
  consolidated: ConsolidatedLine[],
  payload: ComputedSaleLine[],
): LineDeltaResult {
  const consolidatedMap = new Map<number, ConsolidatedLine>();
  for (const line of consolidated) {
    consolidatedMap.set(Number(line.item_id), line);
  }
  // Agrupamos el payload por product_id sumando cantidades: si el cliente
  // envía dos líneas para el MISMO producto (caso teórico — el UI no debería
  // pero el contrato no lo prohíbe), las consolidamos antes del delta.
  const payloadMap = new Map<number, ComputedSaleLine & { _aggQty: Big }>();
  for (const line of payload) {
    const key = Number(line.product_id);
    const existing = payloadMap.get(key);
    if (existing) {
      existing._aggQty = existing._aggQty.plus(toBig(line.quantity));
    } else {
      payloadMap.set(key, { ...line, _aggQty: toBig(line.quantity) });
    }
  }

  const removedOrReduced: LineDifference[] = [];
  const addedOrIncreased: LineDifference[] = [];

  for (const [productId, currentLine] of consolidatedMap) {
    const newLine = payloadMap.get(productId);
    if (!newLine) {
      // Línea eliminada por completo.
      removedOrReduced.push(buildRemovedDifference(currentLine));
      continue;
    }
    const currentQty = toBig(currentLine.quantity);
    const newQty = newLine._aggQty;
    if (newQty.lt(currentQty)) {
      const diffQty = currentQty.minus(newQty);
      removedOrReduced.push(buildReducedDifference(currentLine, diffQty));
    }
  }

  for (const [productId, newLine] of payloadMap) {
    const currentLine = consolidatedMap.get(productId);
    if (!currentLine) {
      // Línea nueva.
      addedOrIncreased.push(buildAddedDifference(newLine));
      continue;
    }
    const currentQty = toBig(currentLine.quantity);
    const newQty = newLine._aggQty;
    if (newQty.gt(currentQty)) {
      const diffQty = newQty.minus(currentQty);
      addedOrIncreased.push(buildIncreasedDifference(newLine, diffQty));
    }
  }

  return {
    removedOrReduced,
    addedOrIncreased,
    isEmpty: removedOrReduced.length === 0 && addedOrIncreased.length === 0,
  };
}

/**
 * Para una línea `removed` o `reduced` solo conocemos los datos vivos del
 * consolidado (cost, price, name). El IVA no vive en `ConsolidatedLine`
 * (se materializa solo en `sale_invoice_lines`), así que tomamos `iva = 0`
 * por consistencia con `total = price * quantity_diff` — paridad PlacePos
 * (PlacePos tampoco persiste IVA en sus credit-note-lines de edit).
 */
function buildRemovedDifference(line: ConsolidatedLine): LineDifference {
  return buildCreditLineDifference('removed', line, toBig(line.quantity));
}

function buildReducedDifference(line: ConsolidatedLine, diffQty: Big): LineDifference {
  return buildCreditLineDifference('reduced', line, diffQty);
}

function buildCreditLineDifference(
  type: 'removed' | 'reduced',
  line: ConsolidatedLine,
  diffQty: Big,
): LineDifference {
  const unitPrice = toBig(line.price);
  const unitCost = toBig(line.cost);
  const subtotal = unitPrice.times(diffQty);
  return {
    type,
    product_id: Number(line.item_id),
    packaging_id: null,
    product_price_id: null,
    description: line.name,
    unit_cost: preciseNumber(unitCost, 2),
    unit_price: preciseNumber(unitPrice, 2),
    quantity: preciseNumber(diffQty, 4),
    subtotal: preciseNumber(subtotal, 2),
    iva_percentage: 0,
    iva_amount: 0,
    total: preciseNumber(subtotal, 2),
  };
}

/**
 * Para `added` / `increased` sí tenemos el payload recalculado por
 * `calculateSaleTotals`, así que aprovechamos su IVA. La línea de ND
 * preserva el IVA de la venta corregida.
 */
function buildAddedDifference(line: ComputedSaleLine): LineDifference {
  return buildDebitLineDifference('added', line, toBig(line.quantity));
}

function buildIncreasedDifference(line: ComputedSaleLine, diffQty: Big): LineDifference {
  return buildDebitLineDifference('increased', line, diffQty);
}

function buildDebitLineDifference(
  type: 'added' | 'increased',
  line: ComputedSaleLine,
  diffQty: Big,
): LineDifference {
  const unitPrice = toBig(line.unit_price);
  const unitCost = toBig(line.unit_cost);
  const ivaPercentage = toBig(line.iva_percentage);
  const subtotal = unitPrice.times(diffQty);
  const ivaAmount = subtotal.times(ivaPercentage).div(100);
  const total = subtotal.plus(ivaAmount);
  return {
    type,
    product_id: Number(line.product_id),
    packaging_id: line.packaging_id === null ? null : Number(line.packaging_id),
    product_price_id: line.product_price_id === null ? null : Number(line.product_price_id),
    description: line.description,
    unit_cost: preciseNumber(unitCost, 2),
    unit_price: preciseNumber(unitPrice, 2),
    quantity: preciseNumber(diffQty, 4),
    subtotal: preciseNumber(subtotal, 2),
    iva_percentage: preciseNumber(ivaPercentage, 4),
    iva_amount: preciseNumber(ivaAmount, 2),
    total: preciseNumber(total, 2),
  };
}
