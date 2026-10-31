import Big from 'big.js';

import { isPerGramProduct, type AmountCandidate } from './amount-request';

/**
 * Pedido POR PESO en una medida ("1 @ de maní", "2 kilos de arroz", "3 libras").
 * Funciones puras (sin BD); `SellerCartService` arma los candidatos.
 *
 * Medidas de Colombia: libra = 500 g, kilo = 2 libras, arroba (@) = 25 libras.
 *
 * Orden de preferencia:
 *   1. La presentación que pesa EXACTAMENTE eso → 1 unidad.
 *   2. Unidades de la presentación más grande que sumen EXACTO ese peso
 *      (1 @ = 25 × LIBRA).
 *   3. Por gramos.
 *   4. Nada cuadra → no se anota; el agente le pregunta al cliente.
 *
 * Si lo que cuadra NO es la medida que dijo el cliente (pidió una arroba y se
 * vende por libra), no se anota: se le OFRECE la equivalencia y se anota cuando
 * acepte.
 */

/** Gramos de UNA unidad de cada medida que entiende el agente. */
export const WEIGHT_UNIT_GRAMS = {
  gramo: 1,
  cuarto: 125,
  media_libra: 250,
  libra: 500,
  kilo: 1000,
  arroba: 12500,
} as const;

export type WeightUnit = keyof typeof WEIGHT_UNIT_GRAMS;

export const WEIGHT_UNITS = Object.keys(WEIGHT_UNIT_GRAMS) as WeightUnit[];

const UNIT_LABEL: Record<WeightUnit, { one: string; many: string }> = {
  gramo: { one: 'gramo', many: 'gramos' },
  cuarto: { one: 'cuarto de libra', many: 'cuartos de libra' },
  media_libra: { one: 'media libra', many: 'medias libras' },
  libra: { one: 'libra', many: 'libras' },
  kilo: { one: 'kilo', many: 'kilos' },
  arroba: { one: 'arroba', many: 'arrobas' },
};

/** Tope del peso pedido (5 toneladas): lo demás es un dato basura. */
export const MAX_WEIGHT_GRAMS = new Big(5_000_000);

export interface WeightRequest {
  quantity: Big;
  unit: WeightUnit;
  /** Peso total pedido, en gramos enteros. */
  grams: Big;
}

/** "1 arroba", "2 kilos", "1,5 libras". */
export const weightLabel = (quantity: Big, unit: WeightUnit): string => {
  const label = quantity.eq(1) ? UNIT_LABEL[unit].one : UNIT_LABEL[unit].many;
  return `${quantity.toString().replace('.', ',')} ${label}`;
};

/**
 * Lee `weight_requested` del modelo: `{ quantity, unit }`. Devuelve `null` si
 * falta algo, la medida no existe o el peso no da gramos enteros.
 */
export const readWeightRequested = (raw: unknown): WeightRequest | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const { quantity: rawQuantity, unit: rawUnit } = raw as Record<string, unknown>;
  const unit = typeof rawUnit === 'string' ? rawUnit.trim().toLowerCase() : '';
  if (!(WEIGHT_UNITS as string[]).includes(unit)) {
    return null;
  }
  const text =
    typeof rawQuantity === 'number'
      ? String(rawQuantity)
      : typeof rawQuantity === 'string'
        ? rawQuantity.trim().replace(',', '.')
        : '';
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return null;
  }
  const quantity = new Big(text);
  const grams = quantity.times(WEIGHT_UNIT_GRAMS[unit as WeightUnit]);
  if (quantity.lte(0) || !grams.round(0).eq(grams) || grams.gt(MAX_WEIGHT_GRAMS)) {
    return null;
  }
  return { quantity, unit: unit as WeightUnit, grams };
};

/** Mayúsculas y sin tildes, para leer la medida del nombre del catálogo. */
const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();

const decimal = (text: string): Big => new Big(text.replace(',', '.'));

/**
 * Gramos de UNA unidad de la presentación, o `null` si no es por peso. Primero
 * el empaque ("GRAMO" × 500 = la libra), luego la medida del nombre
 * ("MANI TOSTADO 1/2 LIBRA CON SAL", "ARROZ X ARROBA", "UVA PASA CJ X 10K").
 */
export const presentationGrams = (product: {
  name: string;
  packaging_name: string | null;
  packaging_value: Big | null;
}): Big | null => {
  if (isPerGramProduct(product)) {
    return new Big(1);
  }

  const packaging = normalize(product.packaging_name ?? '');
  const value = product.packaging_value;
  if (value !== null && value.gt(0)) {
    if (/\b(GRAMOS?|GRS?)\b/.test(packaging)) return value;
    if (/\b(KILOS?|KG)\b/.test(packaging)) return value.times(1000);
    if (/\bLIBRAS?\b/.test(packaging)) return value.times(500);
    if (/\bARROBAS?\b/.test(packaging)) return value.times(12500);
  }

  const name = normalize(product.name);
  if (/\bMEDIA\s+ARROBA\b/.test(name)) return new Big(6250);
  if (/\bARROBA\b/.test(name)) return new Big(12500);
  const kilos = /(\d+(?:[.,]\d+)?)\s*(?:KG|KILOS?|K)\b/.exec(name);
  if (kilos) return decimal(kilos[1]).times(1000);
  if (/\bMEDIO\s+KILO\b/.test(name)) return new Big(500);
  if (/\bKILO\b/.test(name)) return new Big(1000);
  if (/(?:\b1\/4|\bCUARTO)\b/.test(name)) return new Big(125);
  if (/(?:\b1\/2|\bMEDIA)\s*(?:DE\s+)?LIBRA\b/.test(name)) return new Big(250);
  const pounds = /(\d+(?:[.,]\d+)?)\s*LIBRAS?\b/.exec(name);
  if (pounds) return decimal(pounds[1]).times(500);
  if (/\bLIBRA\b/.test(name)) return new Big(500);
  const grams = /(\d+)\s*(?:G|GR|GRS|GRAMOS?)\b/.exec(name);
  if (grams) return new Big(grams[1]);
  return null;
};

/** Una presentación candidata con lo que pesa UNA unidad (`null` = no es por peso). */
export interface WeightCandidate extends AmountCandidate {
  grams: Big | null;
}

export type WeightResolution =
  | {
      kind: 'exact' | 'units' | 'by_gram';
      product: WeightCandidate;
      quantity: Big;
      total: Big;
      /**
       * `true` si es la medida que dijo el cliente (pidió 3 libras y se anotan 3
       * libras): se anota. `false` = es una equivalencia (pidió 1 @ y se vende
       * por libra): se le ofrece primero.
       */
      same_measure: boolean;
    }
  | { kind: 'none' };

const byId = (list: WeightCandidate[], chosenId: number): WeightCandidate =>
  list.find((candidate) => candidate.id === chosenId) ?? [...list].sort((a, b) => a.id - b.id)[0];

export const resolveWeightRequest = (
  request: WeightRequest,
  candidates: readonly WeightCandidate[],
  chosenId: number,
): WeightResolution => {
  const unitGrams = WEIGHT_UNIT_GRAMS[request.unit];
  const fixed = candidates.filter(
    (c): c is WeightCandidate & { grams: Big } =>
      c.unit_price.gt(0) && !c.per_gram && c.grams !== null && c.grams.gt(0),
  );

  // 1. La presentación de ese peso exacto.
  const exact = fixed.filter((c) => c.grams.eq(request.grams));
  if (exact.length > 0) {
    const product = byId(exact, chosenId);
    return {
      kind: 'exact',
      product,
      quantity: new Big(1),
      total: product.unit_price,
      same_measure: true,
    };
  }

  // 2. Unidades de la presentación más grande que sumen exacto.
  const units = fixed
    .filter((c) => c.grams.lt(request.grams) && request.grams.mod(c.grams).eq(0))
    .sort((a, b) => (b.grams.gt(a.grams) ? 1 : b.grams.lt(a.grams) ? -1 : a.id - b.id));
  if (units.length > 0) {
    const product = units[0];
    const quantity = request.grams.div(product.grams);
    return {
      kind: 'units',
      product,
      quantity,
      total: product.unit_price.times(quantity).round(2),
      same_measure: product.grams.eq(unitGrams),
    };
  }

  // 3. Por gramos.
  const byGram = candidates.filter((c) => c.per_gram && c.unit_price.gt(0));
  if (byGram.length > 0) {
    const product = byId(byGram, chosenId);
    return {
      kind: 'by_gram',
      product,
      quantity: request.grams,
      total: product.unit_price.times(request.grams).round(2),
      same_measure: request.unit === 'gramo',
    };
  }

  return { kind: 'none' };
};
