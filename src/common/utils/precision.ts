import Big from 'big.js';

/**
 * Helpers de precisión monetaria — espejo de
 * `placepos/src/main/utils/precision.ts`. Los nombres se mantienen idénticos
 * para que cualquier dev que se mueva entre repos no tenga que reaprender.
 *
 * Regla absoluta: cualquier suma/resta/multiplicación/división de dinero,
 * cantidades o márgenes pasa por `toBig(...)` ANTES de operar. Nunca operes
 * con `number` directo en lógica financiera (IEEE 754 introduce errores como
 * `0.1 + 0.2 = 0.30000000000000004`).
 */

/**
 * Convierte cualquier entrada (number, string, Big, null/undefined) en un
 * `Big`. Si el valor es nulo o indefinido, devuelve `Big(0)` — útil para
 * iteradores `reduce` que acumulan sobre campos opcionales.
 */
export function toBig(value: unknown): Big {
  if (value === null || value === undefined) {
    return new Big(0);
  }
  return new Big(value as Big.BigSource);
}

/**
 * Redondea con `ROUND_HALF_UP` (configurado globalmente en `main.ts`) a la
 * `scale` indicada y retorna `number`. Usar al persistir o exponer un total
 * calculado. **Nunca** redondees en pasos intermedios; solo al final.
 */
export function preciseNumber(value: unknown, scale = 2): number {
  return Number(toBig(value).round(scale).toString());
}

/**
 * Ganancia bruta = `salePrice - cost`. Se redondea a 2 decimales (escala
 * monetaria por defecto).
 */
export function calculateProfit(salePrice: unknown, cost: unknown): number {
  return preciseNumber(toBig(salePrice).minus(toBig(cost)), 2);
}

/**
 * Margen porcentual sobre precio de venta: `(profit / salePrice) * 100`.
 * Si `salePrice` es 0, devuelve 0 (evita división por cero / `Infinity`).
 * Escala 4 — los márgenes requieren precisión fina para reportes.
 */
export function calculateMargin(salePrice: unknown, cost: unknown): number {
  const price = toBig(salePrice);
  if (price.eq(0)) {
    return 0;
  }
  const profit = price.minus(toBig(cost));
  return preciseNumber(profit.div(price).times(100), 4);
}
