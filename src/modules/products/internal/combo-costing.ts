import Big from 'big.js';

/**
 * Matemática PURA del producto COMBO — espejo byte-a-byte de
 * `placepos/src/main/database/utils/comboCosting.ts`.
 *
 * Un COMBO es un producto de nivel raíz (`parent_id` NULL) que NO tiene stock
 * propio: se arma a partir de N productos BASE ("componentes"). Cada componente
 * aporta una `quantity` expresada en la UNIDAD MÍNIMA de ese base — la misma
 * unidad en la que vive `products.stock`.
 *
 * Es el mismo modelo de una PRESENTACIÓN, pero con N anclas en vez de una:
 *   presentación → costo = (costo_base / valor_empaque_base) × valor_empaque
 *   combo        → costo = Σ (costo_base_i / valor_empaque_base_i) × cantidad_i
 *
 * El redondeo se hace POR LÍNEA a 2 decimales y el total es la suma de las
 * líneas redondeadas, de modo que el total que ve el usuario sea EXACTAMENTE la
 * suma de los costos por componente que le muestra el formulario.
 */

export interface ComboComponentCostInput {
  /** Costo del producto base, en su unidad de EMPAQUE (tal cual `products.cost`). */
  component_cost: number;
  /** `packagings.value` del base (factor a unidad mínima). null/<=0 ⇒ 1. */
  component_packaging_value: number | null;
  /** Cantidad que lleva el combo, en la unidad MÍNIMA del base. */
  quantity: number;
}

/** Normaliza el factor de empaque: null, 0, negativo o no finito ⇒ 1. */
function safePackagingValue(value: number | null | undefined): Big {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return new Big(1);
  }
  return new Big(num);
}

/**
 * Costo que aporta UN componente al combo, redondeado a 2 decimales.
 *
 *   costo_unidad_minima = component_cost / component_packaging_value
 *   aporte              = costo_unidad_minima × quantity
 *
 * Cantidad no positiva o no finita ⇒ 0 (el guard de negocio la rechaza antes;
 * aquí solo evitamos propagar NaN a la BD).
 */
export function computeComponentCost(input: ComboComponentCostInput): number {
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return 0;
  }
  const cost = Number(input.component_cost);
  if (!Number.isFinite(cost)) {
    return 0;
  }
  return Number(
    new Big(cost)
      .div(safePackagingValue(input.component_packaging_value))
      .times(quantity)
      .round(2, Big.roundHalfUp)
      .toString(),
  );
}

/** Costo TOTAL del combo = Σ de los aportes por componente (ya redondeados). */
export function computeComboCost(inputs: ComboComponentCostInput[]): number {
  return Number(
    inputs
      .reduce((total, input) => total.plus(computeComponentCost(input)), new Big(0))
      .round(2, Big.roundHalfUp)
      .toString(),
  );
}

export interface ComboComponentStockInput {
  /** Stock actual del base, en unidad mínima. */
  component_stock: number;
  /** Cantidad que consume el combo, en la unidad mínima del base. */
  quantity: number;
}

/**
 * Stock DERIVADO del combo: cuántas unidades COMPLETAS se pueden armar hoy con
 * el stock de sus componentes. Es el mínimo de `trunc(stock_i / cantidad_i)`.
 *
 * - Sin componentes ⇒ 0 (no se puede armar nada).
 * - Cantidad no positiva ⇒ el componente se ignora (no puede limitar).
 * - Se trunca HACIA CERO (no floor): un componente sobregirado leve (−2 g para
 *   una receta de 25 g) da 0 combos, no −1.
 */
export function computeComboStock(inputs: ComboComponentStockInput[]): number {
  let min: Big | null = null;
  for (const input of inputs) {
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      continue;
    }
    const stock = Number(input.component_stock);
    const available = new Big(Number.isFinite(stock) ? stock : 0)
      .div(quantity)
      .round(0, Big.roundDown);
    if (min === null || available.lt(min)) {
      min = available;
    }
  }
  // `min.eq(0)` normaliza el −0 que produce truncar hacia cero un negativo.
  return min === null || min.eq(0) ? 0 : Number(min.toString());
}
