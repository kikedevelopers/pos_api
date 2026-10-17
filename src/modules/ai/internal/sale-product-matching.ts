import Big from 'big.js';

/**
 * Motor de coincidencia de productos para los pedidos que prepara Place.
 *
 * El usuario dice "fécula de maíz por libra", "maizena x media", "2 libras de
 * fécula" o "azúcar 500g"; en el inventario está "FECULA DE MAIZ X LIBRA". Este
 * módulo traduce lo primero a lo segundo SIN BD (la consulta ya trajo el pool de
 * candidatos), de forma determinista y probada caso por caso:
 *
 *   1. Separa cada texto en NÚCLEO (qué es: "fecula", "maiz") y TAMAÑO (cuánto:
 *      libra = 500 g, media libra = 250 g, kilo = 1000 g, "500 ml", "caja"…).
 *   2. Un candidato es de la FAMILIA si contiene todo el núcleo pedido
 *      (tolerando plurales, abreviaturas y un error de tipeo).
 *   3. Si en la familia hay un tamaño IGUAL al pedido y un único mejor
 *      candidato → resuelto. Si hay empate → ambiguo (Place pregunta).
 *   4. Si la familia existe pero no en ese tamaño → ofrece los tamaños que SÍ
 *      hay (primero los menores, como pide el negocio: media libra, gramos) con
 *      la cantidad equivalente ("2 libras" = 4 × media libra = 1000 × gramo).
 *
 * Fail-closed: ante la duda NO resuelve. El usuario siempre ve el resumen del
 * pedido antes de confirmarlo.
 */

// ──────────────────────────────────────────────────────────────────────────
// Normalización
// ──────────────────────────────────────────────────────────────────────────

/** Palabras que no distinguen un producto de otro. */
const STOPWORDS = new Set([
  'a',
  'al',
  'con',
  'de',
  'del',
  'el',
  'en',
  'la',
  'las',
  'lo',
  'los',
  'o',
  'para',
  'por',
  'su',
  'sus',
  'un',
  'una',
  'unas',
  'unos',
  'x',
  'y',
]);

type Dimension = 'weight' | 'volume' | 'pack';

interface UnitDefinition {
  dimension: Dimension;
  /** Gramos o mililitros por unidad. Para `pack`, 1. */
  amount: number;
  /** Nombre canónico (para `pack` es lo que se compara). */
  canonical: string;
}

const weight = (canonical: string, amount: number): UnitDefinition => ({
  dimension: 'weight',
  amount,
  canonical,
});
const volume = (canonical: string, amount: number): UnitDefinition => ({
  dimension: 'volume',
  amount,
  canonical,
});
const pack = (canonical: string): UnitDefinition => ({ dimension: 'pack', amount: 1, canonical });

/**
 * Unidades reconocidas. La libra colombiana es de 500 g (así la manejan el
 * inventario y las básculas de tienda), la arroba de 12,5 kg.
 */
const UNITS: Record<string, UnitDefinition> = {
  g: weight('gramo', 1),
  gr: weight('gramo', 1),
  grs: weight('gramo', 1),
  gramo: weight('gramo', 1),
  gramos: weight('gramo', 1),
  kg: weight('kilo', 1000),
  kgs: weight('kilo', 1000),
  kilo: weight('kilo', 1000),
  kilos: weight('kilo', 1000),
  kilogramo: weight('kilo', 1000),
  kilogramos: weight('kilo', 1000),
  lb: weight('libra', 500),
  lbs: weight('libra', 500),
  libra: weight('libra', 500),
  libras: weight('libra', 500),
  arroba: weight('arroba', 12500),
  arrobas: weight('arroba', 12500),
  ml: volume('ml', 1),
  cc: volume('ml', 1),
  mililitro: volume('ml', 1),
  mililitros: volume('ml', 1),
  l: volume('litro', 1000),
  lt: volume('litro', 1000),
  lts: volume('litro', 1000),
  litro: volume('litro', 1000),
  litros: volume('litro', 1000),
  galon: volume('galon', 3785),
  galones: volume('galon', 3785),
  unidad: pack('unidad'),
  unidades: pack('unidad'),
  und: pack('unidad'),
  unds: pack('unidad'),
  caja: pack('caja'),
  cajas: pack('caja'),
  paca: pack('paca'),
  pacas: pack('paca'),
  bulto: pack('bulto'),
  bultos: pack('bulto'),
  bolsa: pack('bolsa'),
  bolsas: pack('bolsa'),
  paquete: pack('paquete'),
  paquetes: pack('paquete'),
  paq: pack('paquete'),
  docena: pack('docena'),
  docenas: pack('docena'),
  display: pack('display'),
  displays: pack('display'),
};

const FRACTIONS: Record<string, number> = {
  media: 0.5,
  medio: 0.5,
  mitad: 0.5,
  cuarto: 0.25,
  cuartos: 0.25,
};

const NUMBER_WORDS: Record<string, number> = {
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

/** Medida de un producto o de lo pedido, en su unidad base (g o ml). */
export interface ProductSize {
  dimension: 'weight' | 'volume';
  /** Gramos (peso) o mililitros (volumen). */
  base_amount: number;
  /** Cómo se lee ("libra", "media libra", "500 gramo"…), para mostrarlo. */
  label: string;
  /** El tamaño se dijo con una fracción ("media libra", "cuarto de libra"). */
  fractional: boolean;
}

export interface ParsedProductText {
  /** Lo que el producto ES (sin tamaño, sin conectores). */
  core: string[];
  /** Medida (peso o volumen). */
  size: ProductSize | null;
  /**
   * Empaque canónico ("caja", "paca", "unidad"…), aparte de la medida: "aceite
   * 3 litros caja" es la caja, no la botella de 3 litros.
   */
  pack: string | null;
}

/**
 * Minúsculas, sin tildes y con los tamaños escritos de forma uniforme:
 * "1/2" → "media", "500g" → "500 g", "1,5" → "1.5".
 */
const normalizeForMatching = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b3\s*\/\s*4\b/g, ' tres cuartos ')
    .replace(/\b1\s*\/\s*2\b/g, ' media ')
    .replace(/\b1\s*\/\s*4\b/g, ' cuarto ')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2');

const tokenize = (value: string): string[] =>
  normalizeForMatching(value).match(/\d+(?:\.\d+)?|[a-zñ]+/g) ?? [];

const isNumberToken = (token: string): boolean => /^\d+(?:\.\d+)?$/.test(token);

/**
 * Lee el tamaño hacia atrás desde la palabra de unidad:
 * "libra" (1), "media libra" (0,5), "cuarto de libra" (0,25),
 * "tres cuartos de libra" (0,75), "500 gr" (500), "1.5 kg" (1,5).
 */
const readSizeBefore = (
  tokens: readonly string[],
  unit_index: number,
): { multiplier: number; consumed: number[]; words: string[]; fractional: boolean } => {
  const consumed: number[] = [];
  const words: string[] = [];
  let index = unit_index - 1;
  if (index >= 0 && tokens[index] === 'de') {
    index -= 1;
  }

  let multiplier = 1;
  if (index >= 0 && FRACTIONS[tokens[index]] !== undefined) {
    multiplier = FRACTIONS[tokens[index]];
    consumed.push(index);
    words.unshift(tokens[index]);
    const before = index - 1;
    if (before >= 0 && NUMBER_WORDS[tokens[before]] !== undefined) {
      multiplier *= NUMBER_WORDS[tokens[before]];
      consumed.push(before);
      words.unshift(tokens[before]);
    } else if (before >= 0 && isNumberToken(tokens[before])) {
      multiplier *= Number(tokens[before]);
      consumed.push(before);
      words.unshift(tokens[before]);
    }
  } else if (index >= 0 && isNumberToken(tokens[index])) {
    multiplier = Number(tokens[index]);
    consumed.push(index);
    words.unshift(tokens[index]);
  }
  if (consumed.length > 0 && tokens[unit_index - 1] === 'de') {
    consumed.push(unit_index - 1);
  }
  return {
    multiplier,
    consumed,
    words,
    fractional: words.some((word) => FRACTIONS[word] !== undefined),
  };
};

/**
 * Parte un texto en núcleo + tamaño. Las palabras de tamaño que no forman un
 * tamaño (un "media" suelto) se descartan del núcleo: "fécula media" no debe
 * exigir que el producto contenga "media".
 */
export const parseProductText = (value: string): ParsedProductText => {
  const tokens = tokenize(value);
  const consumed = new Set<number>();
  let size: ProductSize | null = null;
  let pack: string | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const unit = UNITS[tokens[index]];
    if (!unit) {
      continue;
    }
    if (unit.dimension === 'pack') {
      // El primer empaque cuenta; un número antes ("24 unidades") se consume.
      if (pack === null) {
        pack = unit.canonical;
        consumed.add(index);
        if (index > 0 && isNumberToken(tokens[index - 1])) {
          consumed.add(index - 1);
        }
      }
      continue;
    }
    if (size !== null) {
      continue;
    }
    // "l" y "g" sueltos solo son unidad si van tras un número ("1 l", "500 g").
    if (
      (tokens[index] === 'l' || tokens[index] === 'g') &&
      !(index > 0 && isNumberToken(tokens[index - 1]))
    ) {
      continue;
    }
    const before = readSizeBefore(tokens, index);
    if (!(before.multiplier > 0)) {
      continue;
    }
    consumed.add(index);
    before.consumed.forEach((position) => consumed.add(position));
    size = {
      dimension: unit.dimension,
      base_amount: new Big(before.multiplier).times(unit.amount).round(4).toNumber(),
      label: [...before.words, unit.canonical].join(' '),
      fractional: before.fractional,
    };
  }

  const core = tokens.filter(
    (token, index) =>
      !consumed.has(index) &&
      !STOPWORDS.has(token) &&
      FRACTIONS[token] === undefined &&
      UNITS[token] === undefined &&
      // Letras sueltas ("x", una "l" sin número) no describen el producto.
      (token.length > 1 || isNumberToken(token)),
  );
  return { core, size, pack };
};

/** ¿Dos medidas son la misma? */
export const sameSize = (a: ProductSize, b: ProductSize): boolean =>
  a.dimension === b.dimension && new Big(a.base_amount).eq(b.base_amount);

// ──────────────────────────────────────────────────────────────────────────
// Coincidencia de palabras
// ──────────────────────────────────────────────────────────────────────────

const singular = (token: string): string => {
  if (token.length > 4 && token.endsWith('es')) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s')) {
    return token.slice(0, -1);
  }
  return token;
};

/** Distancia de edición con tope (corta en cuanto supera `max`). */
const withinEditDistance = (a: string, b: string, max: number): boolean => {
  if (Math.abs(a.length - b.length) > max) {
    return false;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let row_min = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      row_min = Math.min(row_min, current[j]);
    }
    if (row_min > max) {
      return false;
    }
    previous = current;
  }
  return previous[b.length] <= max;
};

/**
 * Qué tan bien una palabra pedida coincide con una del producto:
 * 1 = igual (o plural), 0,8 = abreviatura ("choco" → "chocolate"),
 * 0,7 = un error de tipeo ("fecla" → "fecula"), 0 = no coincide.
 */
export const tokenMatchScore = (wanted: string, candidate: string): number => {
  if (wanted === candidate || singular(wanted) === singular(candidate)) {
    return 1;
  }
  if (isNumberToken(wanted) || isNumberToken(candidate)) {
    return 0;
  }
  if (wanted.length >= 4 && candidate.startsWith(wanted)) {
    return 0.8;
  }
  if (wanted.length >= 5 && candidate.length >= 5 && withinEditDistance(wanted, candidate, 1)) {
    return 0.7;
  }
  return 0;
};

/** Cómo encaja un producto con UNA forma de pedirlo. */
export interface CoreMatch {
  /** Fracción del núcleo pedido que el producto contiene (1 = todo). */
  coverage: number;
  /** Calidad promedio de las palabras que coincidieron (0..1). */
  quality: number;
  /** Palabras del producto que el usuario no mencionó. */
  extra: number;
}

export const matchCore = (wanted: readonly string[], candidate: readonly string[]): CoreMatch => {
  if (wanted.length === 0) {
    return { coverage: 0, quality: 0, extra: candidate.length };
  }
  const used = new Set<number>();
  let matched = 0;
  let quality_sum = 0;
  for (const token of wanted) {
    let best = 0;
    let best_index = -1;
    candidate.forEach((other, index) => {
      if (used.has(index)) {
        return;
      }
      const score = tokenMatchScore(token, other);
      if (score > best) {
        best = score;
        best_index = index;
      }
    });
    if (best_index >= 0) {
      used.add(best_index);
      matched += 1;
      quality_sum += best;
    }
  }
  return {
    coverage: matched / wanted.length,
    quality: matched > 0 ? quality_sum / matched : 0,
    extra: candidate.length - used.size,
  };
};

// ──────────────────────────────────────────────────────────────────────────
// Resolución de una línea
// ──────────────────────────────────────────────────────────────────────────

/** Lo mínimo que el motor necesita de un producto del pool. */
export interface MatchableProduct {
  id: number;
  name: string;
  sku_code: string | null;
  bar_code: string | null;
  /** Nombre del empaque: tamaño de respaldo si el nombre no lo dice. */
  packaging_name: string | null;
}

export interface SizeAlternative<T extends MatchableProduct> {
  product: T;
  /** Medida del producto, si se pudo leer. */
  size: ProductSize | null;
  /** Empaque del producto, si lo dice. */
  pack: string | null;
  /** Cantidad de ESTE producto que equivale a lo pedido (misma medida y empaque). */
  equivalent_quantity: number | null;
}

export type LineMatch<T extends MatchableProduct> =
  | { status: 'resolved'; product: T; via: 'code' | 'name' }
  | { status: 'ambiguous'; options: T[] }
  | {
      status: 'size_unavailable';
      requested_size: string;
      alternatives: Array<SizeAlternative<T>>;
    }
  | { status: 'not_found'; similar: T[] };

/** Máximo de opciones que se le devuelven al modelo por línea. */
export const MAX_LINE_OPTIONS = 8;

interface ScoredCandidate<T extends MatchableProduct> {
  product: T;
  size: ProductSize | null;
  pack: string | null;
  match: CoreMatch;
}

const parsedCache = new WeakMap<MatchableProduct, ParsedProductText>();

/**
 * Núcleo, medida y empaque de un producto. Lo que el nombre no dice cae al
 * empaque registrado ("LIBRA" → 500 g, "CAJA" → caja).
 */
export const parseProduct = (product: MatchableProduct): ParsedProductText => {
  const cached = parsedCache.get(product);
  if (cached) {
    return cached;
  }
  const parsed = parseProductText(product.name);
  const fallback = product.packaging_name ? parseProductText(`1 ${product.packaging_name}`) : null;
  const result: ParsedProductText = {
    core: parsed.core,
    size: parsed.size ?? fallback?.size ?? null,
    pack: parsed.pack ?? fallback?.pack ?? null,
  };
  parsedCache.set(product, result);
  return result;
};

const normalizeCode = (value: string): string => value.trim().toLowerCase();

/** Ordena: más núcleo cubierto, mejor calidad, menos palabras sobrantes. */
const compareCandidates = <T extends MatchableProduct>(
  a: ScoredCandidate<T>,
  b: ScoredCandidate<T>,
): number =>
  b.match.coverage - a.match.coverage ||
  b.match.quality - a.match.quality ||
  a.match.extra - b.match.extra ||
  a.product.name.localeCompare(b.product.name);

const ambiguous = <T extends MatchableProduct>(
  candidates: ReadonlyArray<ScoredCandidate<T>>,
): LineMatch<T> => ({
  status: 'ambiguous',
  options: candidates.slice(0, MAX_LINE_OPTIONS).map((candidate) => candidate.product),
});

/** Huella de medida + empaque, para saber si la familia trae tamaños distintos. */
const sizeKey = (candidate: ScoredCandidate<MatchableProduct>): string =>
  `${candidate.size ? `${candidate.size.dimension}:${candidate.size.base_amount}` : '-'}|${candidate.pack ?? '-'}`;

/**
 * Elige SOLO si no hay duda (fail-closed). Resuelve cuando:
 *   - todas las palabras pedidas coinciden EXACTO (o en plural): una
 *     abreviatura o un error de tipeo ("papa" → PAPAYA) nunca se elige sola;
 *   - y es el único candidato, o es el nombre EXACTO (sin palabras de más)
 *     frente a otros que sí tienen palabras de más ("arroz por libra" →
 *     ARROZ X LIBRA, no ARROZ INTEGRAL X LIBRA), o los demás coinciden peor.
 * Dos marcas o presentaciones con palabras de más ("aceite" → girasol u
 * oliva) → ambiguo: Place pregunta.
 */
const pickUnique = <T extends MatchableProduct>(
  sorted: ReadonlyArray<ScoredCandidate<T>>,
): LineMatch<T> => {
  const [best, second] = sorted;
  if (best.match.quality < 1) {
    return ambiguous(sorted);
  }
  if (
    second === undefined ||
    second.match.quality < best.match.quality ||
    (best.match.extra === 0 && second.match.extra > 0)
  ) {
    return { status: 'resolved', product: best.product, via: 'name' };
  }
  return ambiguous(sorted);
};

/**
 * Tamaños disponibles de la familia cuando el pedido no existe: primero los
 * MENORES (del más cercano al más pequeño), luego los mayores, luego los que
 * no tienen medida comparable. La cantidad equivalente solo cuando la medida
 * es comparable y el empaque coincide.
 */
const sizeAlternatives = <T extends MatchableProduct>(
  family: ReadonlyArray<ScoredCandidate<T>>,
  requested: ProductSize | null,
  requested_pack: string | null,
  quantity: Big | null,
): Array<SizeAlternative<T>> => {
  const comparable = (candidate: ScoredCandidate<T>): boolean =>
    requested !== null &&
    candidate.size !== null &&
    candidate.size.dimension === requested.dimension &&
    candidate.pack === requested_pack;
  const amount = (candidate: ScoredCandidate<T>): number =>
    (candidate.size as ProductSize).base_amount;
  const target = requested?.base_amount ?? 0;
  const smaller = family
    .filter((c) => comparable(c) && amount(c) < target)
    .sort((a, b) => amount(b) - amount(a));
  const larger = family
    .filter((c) => comparable(c) && amount(c) > target)
    .sort((a, b) => amount(a) - amount(b));
  const others = family.filter((c) => !comparable(c));

  return [...smaller, ...larger, ...others].slice(0, MAX_LINE_OPTIONS).map((candidate) => ({
    product: candidate.product,
    size: candidate.size,
    pack: candidate.pack,
    equivalent_quantity:
      comparable(candidate) && quantity !== null && requested !== null
        ? quantity.times(requested.base_amount).div(amount(candidate)).round(4).toNumber()
        : null,
  }));
};

/**
 * Resuelve UNA línea del pedido contra el pool de candidatos.
 *
 * @param queries   Formas de nombrar el producto: lo que dijo el usuario y las
 *                  alternativas que propone el modelo ("maizena" → "fécula de
 *                  maíz"). Gana la que mejor encaje con cada candidato. La
 *                  medida y el empaque los manda lo que dijo el usuario (la
 *                  primera forma que los traiga).
 * @param quantity  Cantidad pedida, para calcular equivalencias de tamaño.
 */
export const matchLine = <T extends MatchableProduct>(
  queries: readonly string[],
  pool: readonly T[],
  quantity: Big | null,
): LineMatch<T> => {
  const cleaned = queries.map((query) => query.trim()).filter((query) => query.length > 0);
  if (cleaned.length === 0) {
    return { status: 'not_found', similar: [] };
  }

  // 1. Código exacto (SKU o código de barras): no hay nada que interpretar.
  const codes = new Set(cleaned.map(normalizeCode));
  const by_code = pool.filter(
    (product) =>
      (product.sku_code !== null && codes.has(normalizeCode(product.sku_code))) ||
      (product.bar_code !== null && codes.has(normalizeCode(product.bar_code))),
  );
  if (by_code.length === 1) {
    return { status: 'resolved', product: by_code[0], via: 'code' };
  }
  if (by_code.length > 1) {
    return { status: 'ambiguous', options: by_code.slice(0, MAX_LINE_OPTIONS) };
  }

  const variants = cleaned.map(parseProductText).filter((variant) => variant.core.length > 0);
  if (variants.length === 0) {
    return { status: 'not_found', similar: [] };
  }
  const requested_size = variants.find((variant) => variant.size !== null)?.size ?? null;
  const requested_pack = variants.find((variant) => variant.pack !== null)?.pack ?? null;

  // 2. Puntaje de cada candidato con la variante que mejor le encaje.
  const scored: Array<ScoredCandidate<T>> = pool.map((product) => {
    const parsed = parseProduct(product);
    const best = variants
      .map((variant) => matchCore(variant.core, parsed.core))
      .sort((a, b) => b.coverage - a.coverage || b.quality - a.quality || a.extra - b.extra)[0];
    return { product, size: parsed.size, pack: parsed.pack, match: best };
  });

  const family = scored
    .filter((candidate) => candidate.match.coverage === 1)
    .sort(compareCandidates);

  if (family.length === 0) {
    const similar = scored
      .filter((candidate) => candidate.match.coverage >= 0.5)
      .sort(compareCandidates)
      .slice(0, MAX_LINE_OPTIONS)
      .map((candidate) => candidate.product);
    return { status: 'not_found', similar };
  }

  // 3. Sin tamaño ni empaque pedidos: si la familia trae tamaños distintos,
  //    se pregunta cuál (nunca se elige el tamaño en silencio).
  if (requested_size === null && requested_pack === null) {
    if (new Set(family.map(sizeKey)).size > 1) {
      return ambiguous(family);
    }
    return pickUnique(family);
  }

  // 4. Con medida y/o empaque: solo los que coinciden en LO QUE SE DIJO.
  const same_size = family.filter(
    (candidate) =>
      (requested_size === null ||
        (candidate.size !== null && sameSize(candidate.size, requested_size))) &&
      (requested_pack === null || candidate.pack === requested_pack),
  );
  if (same_size.length > 0) {
    return pickUnique(same_size);
  }

  return {
    status: 'size_unavailable',
    requested_size: [requested_size?.label, requested_pack].filter(Boolean).join(' '),
    alternatives: sizeAlternatives(family, requested_size, requested_pack, quantity),
  };
};

/**
 * ¿El modelo contó la fracción DOS veces? "media libra de fécula" es UNA unidad
 * de "fécula por media libra" (o 0,5 de "fécula por libra"), nunca 0,5 de
 * "fécula por media libra" (= un cuarto de libra). Si el tamaño pedido se dijo
 * con una fracción y la cantidad también es fraccionaria, la línea no se
 * interpreta: se le devuelve al modelo para que la corrija.
 */
export const isFractionCountedTwice = (queries: readonly string[], quantity: Big): boolean => {
  if (quantity.round(0, Big.roundDown).eq(quantity)) {
    return false;
  }
  return queries.some((query) => parseProductText(query).size?.fractional === true);
};

/**
 * Patrones `LIKE` para traer el pool de candidatos en UNA consulta: el inicio
 * (4 letras) de cada palabra del núcleo. Corto a propósito para que plurales,
 * abreviaturas y errores al final de la palabra entren al pool; el puntaje fino
 * lo hace `matchLine`.
 */
export const buildCandidatePatterns = (queries: readonly string[]): string[] => {
  const patterns = new Set<string>();
  for (const query of queries) {
    for (const token of parseProductText(query).core) {
      if (token.length < 3 && !isNumberToken(token)) {
        continue;
      }
      if (isNumberToken(token) && token.length < 2) {
        continue;
      }
      const stem = token.length > 4 ? token.slice(0, 4) : token;
      patterns.add(`%${stem.replace(/[\\%_]/g, '\\$&')}%`);
    }
  }
  return [...patterns];
};
