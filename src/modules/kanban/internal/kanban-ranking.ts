/**
 * Rank fraccionado para ordenar tableros y tarjetas. La `position` es
 * `double precision`: insertar/mover entre dos vecinos es tomar el punto medio,
 * un único UPDATE sin renumerar el resto (O(1), ideal con concurrencia).
 *
 * Funciones PURAS (sin DB) para poder testear la aritmética del rank aparte.
 */

/** Separación por defecto entre items recién creados / rebalanceados. */
export const RANK_STEP = 1024;

/**
 * Hueco mínimo entre dos posiciones antes de forzar un rebalanceo. Con doubles
 * (~15-16 dígitos significativos) el punto medio se agota tras ~50 inserciones
 * consecutivas en el mismo hueco; este umbral lo detecta mucho antes.
 */
export const RANK_MIN_GAP = 1e-6;

/** Posición al final de una lista (después del máximo actual, o al inicio si vacía). */
export const rankAtEnd = (maxPosition: number | null): number =>
  (maxPosition ?? 0) + RANK_STEP;

/**
 * Posición entre dos vecinos por punto medio. `prev`/`next` son las posiciones
 * de los vecinos superior/inferior en el destino (null = extremo de la lista).
 * Devuelve `null` cuando el hueco es demasiado pequeño y hace falta rebalancear
 * antes de recalcular.
 */
export const rankBetween = (
  prev: number | null,
  next: number | null,
): number | null => {
  if (prev === null && next === null) return RANK_STEP;
  if (prev === null) return (next as number) - RANK_STEP;
  if (next === null) return prev + RANK_STEP;
  if (next - prev < RANK_MIN_GAP) return null; // hueco agotado → rebalanceo
  return (prev + next) / 2;
};

/** Posiciones equiespaciadas (STEP, 2·STEP, …) para un rebalanceo de `count` items. */
export const rebalancedPositions = (count: number): number[] =>
  Array.from({ length: count }, (_, i) => (i + 1) * RANK_STEP);
