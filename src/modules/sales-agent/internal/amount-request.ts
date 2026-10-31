import Big from 'big.js';

/**
 * Pedido POR VALOR ("2000 de pimienta"): qué presentación y cuántas unidades.
 * Funciones puras (sin BD); `SellerCartService` arma los candidatos.
 *
 * Orden de preferencia (regla del negocio):
 *   1. La presentación que cuesta EXACTAMENTE ese valor → 1 unidad.
 *   2. Por gramos: los gramos que alcanzan SIN pasarse del valor.
 *   3. Unidades fijas que sumen EXACTO el valor (2 × $1.000), con las menos
 *      unidades posibles.
 *   4. Nada cuadra → no se anota; el agente le pregunta al cliente.
 */

/** Una presentación candidata de la misma línea de producto. */
export interface AmountCandidate {
  id: number;
  name: string;
  /** Precio por defecto de UNA unidad. */
  unit_price: Big;
  /** Se vende por gramo (la cantidad son gramos). */
  per_gram: boolean;
}

export type AmountResolution =
  | { kind: 'exact' | 'by_gram' | 'units'; product: AmountCandidate; quantity: Big; total: Big }
  | { kind: 'none' };

/** Palabras que marcan dónde empieza la presentación en el nombre del catálogo. */
const PRESENTATION_MARK = /\s+(?:PAQ\.?|PAQUETE|PQT|X|TIRA|CJ|CAJA|SOBRE|BOLSA|-)(?=\s|$)/i;

/**
 * Nombre base de la línea de producto, sin la presentación:
 * "PIMIENTA NEGRA MOLIDA PAQ. X $1 000" → "PIMIENTA NEGRA MOLIDA". Sirve para
 * encontrar las otras presentaciones sueltas (sin `parent_id`) de esa línea.
 */
export const productLineStem = (name: string): string => {
  const clean = name.replace(/\s+/g, ' ').trim();
  const match = PRESENTATION_MARK.exec(clean);
  const stem = (match ? clean.slice(0, match.index) : clean).trim();
  return stem || clean;
};

/**
 * ¿Se vende por gramo? Empaque de 1 gramo ("1 - GRAMO") o nombre que termina en
 * "GRAMO" ("PIMIENTA NEGRA MOLIDA X GRAMO", "UVA PASA GRAMO").
 */
export const isPerGramProduct = (product: {
  name: string;
  packaging_name: string | null;
  packaging_value: Big | null;
}): boolean => {
  const packaging = product.packaging_name ?? '';
  if (/\bGRAMOS?\b/i.test(packaging) && product.packaging_value?.eq(1)) {
    return true;
  }
  return /(?:^|\s)(?:X\s+)?GRAMOS?$/i.test(product.name.trim());
};

/** Entre empates de precio exacto, el paquete es lo que el cliente espera. */
const looksLikePackage = (name: string): boolean => /\b(PAQ\.?|PAQUETE|PQT)\b/i.test(name);

const pick = (list: AmountCandidate[], chosenId: number): AmountCandidate =>
  list.find((candidate) => candidate.id === chosenId) ??
  list.find((candidate) => looksLikePackage(candidate.name)) ??
  [...list].sort((a, b) => a.id - b.id)[0];

export const resolveAmountRequest = (
  amount: Big,
  candidates: readonly AmountCandidate[],
  chosenId: number,
): AmountResolution => {
  const priced = candidates.filter((candidate) => candidate.unit_price.gt(0));

  // 1. Precio exacto (nunca un producto por gramo: su "unidad" es 1 g).
  const exact = priced.filter((c) => !c.per_gram && c.unit_price.eq(amount));
  if (exact.length > 0) {
    const product = pick(exact, chosenId);
    return { kind: 'exact', product, quantity: new Big(1), total: product.unit_price };
  }

  // 2. Por gramos, sin pasarse del valor.
  const byGram = priced
    .filter((c) => c.per_gram)
    .map((c) => ({ c, grams: amount.div(c.unit_price).round(0, Big.roundDown) }))
    .filter(({ grams }) => grams.gte(1));
  if (byGram.length > 0) {
    const chosen = byGram.find(({ c }) => c.id === chosenId) ?? byGram[0];
    return {
      kind: 'by_gram',
      product: chosen.c,
      quantity: chosen.grams,
      total: chosen.c.unit_price.times(chosen.grams).round(2),
    };
  }

  // 3. Unidades fijas que sumen exacto: la presentación más grande que divida el valor.
  const units = priced
    .filter((c) => !c.per_gram && c.unit_price.lt(amount) && amount.mod(c.unit_price).eq(0))
    .sort((a, b) =>
      b.unit_price.gt(a.unit_price) ? 1 : b.unit_price.lt(a.unit_price) ? -1 : a.id - b.id,
    );
  if (units.length > 0) {
    const product = units[0];
    const quantity = amount.div(product.unit_price);
    return { kind: 'units', product, quantity, total: amount };
  }

  return { kind: 'none' };
};
