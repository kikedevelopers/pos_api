import Big from 'big.js';

import { readMoneyArg, normalizeText } from './expense-tool-helpers';
import { MAX_LINE_ALTERNATIVES, readQuantityArg } from './sale-tool-helpers';
import {
  matchCore,
  parseProduct,
  parseProductText,
  type LineMatch,
  type MatchableProduct,
} from './sale-product-matching';

/**
 * Reglas puras de las herramientas de DOCUMENTOS y COMPRAS de Place: el
 * usuario adjunta la factura de un proveedor (foto o PDF), Place la lee y
 *
 *   - `match_document_products` cruza sus ítems con el inventario (¿existe?,
 *     ¿cuánto stock hay?), y
 *   - `prepare_purchase` / `confirm_purchase` la registran como COMPRA.
 *
 * Fail-closed, como los pedidos: un ítem solo se da por encontrado si el
 * código coincide o el nombre no deja dudas. Un nombre PARECIDO nunca se elige
 * solo: se le pregunta al usuario ("Encontré X, ¿es el mismo producto?").
 */

/** Ítems de un documento que se cruzan en una sola llamada. */
export const MAX_DOCUMENT_ITEMS = 60;

/** Productos parecidos que se le muestran al usuario por ítem. */
export const MAX_DOCUMENT_CANDIDATES = 5;

const MAX_DESCRIPTION_LENGTH = 200;
const MAX_CODE_LENGTH = 64;
const MAX_INVOICE_NUMBER_LENGTH = 64;

/**
 * Desviación del costo frente a la última compra que amerita una advertencia
 * (30 %): casi siempre es una cantidad leída en otra unidad (unidades vs cajas).
 */
export const COST_DEVIATION_THRESHOLD = new Big('0.3');

/** Diferencia tolerada entre el total calculado y el que imprime la factura (1 %). */
export const DOCUMENT_TOTAL_TOLERANCE = new Big('0.01');

// ──────────────────────────────────────────────────────────────────────────
// Lectura de argumentos
// ──────────────────────────────────────────────────────────────────────────

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readText = (raw: unknown, max: number): string | null => {
  if (typeof raw !== 'string') {
    return null;
  }
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, max);
};

/** Un ítem tal como aparece en el documento (sin cantidad). */
export interface DocumentItemRequest {
  /** Posición (1..n) para referirse al ítem en la respuesta. */
  position: number;
  /** Descripción tal cual la imprime el documento. */
  description: string;
  /** Código / referencia / EAN si el documento lo trae. */
  code: string | null;
  /** Nombres genéricos que propone el modelo ("Maizena" → "fécula de maíz"). */
  alternatives: string[];
}

export type DocumentItemsReadResult =
  | { status: 'ok'; items: DocumentItemRequest[] }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

const readAlternatives = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : [])
    .map((value) => readText(value, MAX_DESCRIPTION_LENGTH))
    .filter((value): value is string => value !== null)
    .slice(0, MAX_LINE_ALTERNATIVES);

const readDocumentItem = (
  raw: unknown,
  position: number,
): DocumentItemRequest | { invalid: string } => {
  const record = asRecord(raw);
  if (!record) {
    return { invalid: `El ítem ${position} no es válido.` };
  }
  const description = readText(record.description, MAX_DESCRIPTION_LENGTH);
  const code = readText(record.code, MAX_CODE_LENGTH);
  if (description === null && code === null) {
    return { invalid: `Al ítem ${position} le falta la descripción.` };
  }
  return {
    position,
    description: description ?? (code as string),
    code,
    alternatives: readAlternatives(record.alternatives),
  };
};

/** Lista de ítems (`items` o `lines`) que manda el modelo. */
const readItemList = (
  args: Record<string, unknown>,
  key: string,
):
  | { status: 'ok'; raw: unknown[] }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string } => {
  const raw = args?.[key];
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    return { status: 'missing' };
  }
  if (!Array.isArray(raw)) {
    return { status: 'invalid', reason: 'Los ítems deben ir en una lista.' };
  }
  if (raw.length > MAX_DOCUMENT_ITEMS) {
    return {
      status: 'invalid',
      reason: `Se pueden procesar máximo ${MAX_DOCUMENT_ITEMS} ítems por llamada.`,
    };
  }
  return { status: 'ok', raw };
};

export const readDocumentItemsArg = (args: Record<string, unknown>): DocumentItemsReadResult => {
  const list = readItemList(args, 'items');
  if (list.status !== 'ok') {
    return list;
  }
  const items: DocumentItemRequest[] = [];
  for (const [index, raw] of list.raw.entries()) {
    const item = readDocumentItem(raw, index + 1);
    if ('invalid' in item) {
      return { status: 'invalid', reason: item.invalid };
    }
    items.push(item);
  }
  return { status: 'ok', items };
};

/** Una línea de la compra que se quiere registrar. */
export interface PurchaseLineRequest extends DocumentItemRequest {
  /** Nombre EXACTO del producto del inventario que el usuario confirmó. */
  product: string | null;
  /** El usuario dijo que este ítem NO es ninguno de su inventario. */
  skip: boolean;
  /** Cantidad facturada, en la unidad del producto (su empaque). */
  quantity: Big;
  /** Costo por esa unidad, SIN IVA. */
  unit_cost: Big;
  /** Porcentaje de IVA (0 a 100). */
  iva_rate: Big;
}

export type PurchaseLinesReadResult =
  | { status: 'ok'; lines: PurchaseLineRequest[] }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

/** IVA de la línea: 0..100, máximo 2 decimales; ausente = 0. */
export const readIvaRateArg = (raw: unknown): Big | { invalid: string } => {
  if (raw === undefined || raw === null || raw === '') {
    return new Big(0);
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { invalid: 'El IVA debe ser un porcentaje numérico (ej. 19).' };
  }
  const rate = new Big(raw);
  if (rate.lt(0) || rate.gt(100)) {
    return { invalid: 'El IVA debe estar entre 0 y 100.' };
  }
  if (!rate.round(2).eq(rate)) {
    return { invalid: 'El IVA admite máximo 2 decimales.' };
  }
  return rate;
};

export const readPurchaseLinesArg = (args: Record<string, unknown>): PurchaseLinesReadResult => {
  const list = readItemList(args, 'lines');
  if (list.status !== 'ok') {
    return list;
  }
  const lines: PurchaseLineRequest[] = [];
  for (const [index, raw] of list.raw.entries()) {
    const position = index + 1;
    const item = readDocumentItem(raw, position);
    if ('invalid' in item) {
      return { status: 'invalid', reason: item.invalid };
    }
    const record = asRecord(raw) as Record<string, unknown>;
    const skip = record.skip === true;

    const quantity = readQuantityArg(record.quantity);
    if (!skip && quantity.status !== 'ok') {
      return {
        status: 'invalid',
        reason:
          quantity.status === 'missing'
            ? `Falta la cantidad del ítem ${position} («${item.description}»).`
            : `Ítem ${position}: ${quantity.reason}`,
      };
    }
    const cost = readMoneyArg(record, 'unit_cost');
    if (!skip && cost.status !== 'ok') {
      return {
        status: 'invalid',
        reason:
          cost.status === 'missing'
            ? `Falta el costo unitario del ítem ${position} («${item.description}»).`
            : `Ítem ${position}: ${cost.reason}`,
      };
    }
    const iva = readIvaRateArg(record.iva_rate);
    if (!(iva instanceof Big)) {
      return { status: 'invalid', reason: `Ítem ${position}: ${iva.invalid}` };
    }

    lines.push({
      ...item,
      product: readText(record.product, MAX_DESCRIPTION_LENGTH),
      skip,
      quantity: quantity.status === 'ok' ? quantity.quantity : new Big(0),
      unit_cost: cost.status === 'ok' ? cost.amount : new Big(0),
      iva_rate: iva,
    });
  }
  return { status: 'ok', lines };
};

/** Número de factura: texto corto, sin saltos. */
export const readInvoiceNumberArg = (raw: unknown): string | null =>
  readText(raw, MAX_INVOICE_NUMBER_LENGTH);

/** Formas de nombrar un ítem que se prueban contra el inventario. */
export const queriesOf = (item: DocumentItemRequest): string[] => [
  item.description,
  ...item.alternatives,
  ...(item.code ? [item.code] : []),
];

// ──────────────────────────────────────────────────────────────────────────
// Coincidencias
// ──────────────────────────────────────────────────────────────────────────

export type DocumentMatch<T extends MatchableProduct> =
  | { status: 'found'; product: T; via: 'code' | 'name' | 'confirmed' }
  | { status: 'possible_match'; candidates: T[] }
  | { status: 'not_found' };

/**
 * ¿Alguna forma de nombrar el ítem dice EXACTAMENTE las mismas palabras que el
 * producto (sin tildes, plurales ni conectores; ni una de más ni de menos)?
 * Más estricto que un pedido: en una venta "panela" puede ser "PANELA X 12",
 * pero en una factura una palabra de más puede ser otro producto y hay que
 * preguntar.
 */
export const isStrictNameMatch = (
  queries: readonly string[],
  product: MatchableProduct,
): boolean => {
  const candidate = parseProduct(product).core;
  return queries.some((query) => {
    const wanted = parseProductText(query).core;
    if (wanted.length === 0) {
      return false;
    }
    const match = matchCore(wanted, candidate);
    return match.coverage === 1 && match.quality === 1 && match.extra === 0;
  });
};

/**
 * Traduce el resultado del motor de coincidencias al lenguaje de un documento:
 * solo lo inequívoco es "encontrado" (código exacto o el mismo nombre, palabra
 * por palabra); lo parecido (ambiguo, otro tamaño, palabras de más o un nombre
 * similar) es "posible coincidencia" y se le pregunta al usuario.
 */
export const classifyDocumentMatch = <T extends MatchableProduct>(
  match: LineMatch<T>,
  queries: readonly string[] = [],
): DocumentMatch<T> => {
  switch (match.status) {
    case 'resolved':
      if (match.via === 'name' && !isStrictNameMatch(queries, match.product)) {
        return { status: 'possible_match', candidates: [match.product] };
      }
      return { status: 'found', product: match.product, via: match.via };
    case 'ambiguous':
      return {
        status: 'possible_match',
        candidates: match.options.slice(0, MAX_DOCUMENT_CANDIDATES),
      };
    case 'size_unavailable':
      return {
        status: 'possible_match',
        candidates: match.alternatives
          .map((alternative) => alternative.product)
          .slice(0, MAX_DOCUMENT_CANDIDATES),
      };
    case 'not_found':
      return match.similar.length > 0
        ? { status: 'possible_match', candidates: match.similar.slice(0, MAX_DOCUMENT_CANDIDATES) }
        : { status: 'not_found' };
  }
};

/** El producto cuyo nombre es EXACTAMENTE el confirmado (sin tildes ni mayúsculas). */
export const findByExactName = <T extends { name: string }>(
  pool: readonly T[],
  name: string,
): T | 'ambiguous' | null => {
  const wanted = normalizeText(name);
  const hits = pool.filter((product) => normalizeText(product.name) === wanted);
  if (hits.length === 1) {
    return hits[0];
  }
  return hits.length > 1 ? 'ambiguous' : null;
};

// ──────────────────────────────────────────────────────────────────────────
// Proveedor
// ──────────────────────────────────────────────────────────────────────────

export interface SupplierRow {
  id: string;
  legal_name: string;
  doc_number: string | null;
}

export type SupplierResolution =
  | { status: 'ok'; supplier: SupplierRow; via: 'document' | 'name' }
  | { status: 'possible_match'; candidates: SupplierRow[] }
  | { status: 'not_found' };

/** Sufijos societarios que no distinguen a un proveedor de otro. */
const LEGAL_SUFFIXES = new Set([
  'sas',
  's',
  'a',
  'sa',
  'ltda',
  'eu',
  'cia',
  'y',
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
]);

const supplierWords = (value: string): string[] =>
  normalizeText(value.replace(/\./g, ''))
    .split(' ')
    .filter((word) => word.length > 0 && !LEGAL_SUFFIXES.has(word));

/** Solo los dígitos de un NIT/cédula ("900.123.456-7" → "9001234567"). */
export const documentDigits = (value: string | null | undefined): string =>
  (value ?? '').replace(/\D/g, '');

/**
 * ¿Es el mismo documento? Tolera que uno traiga el dígito de verificación del
 * NIT y el otro no ("900123456-7" ≡ "900123456").
 */
export const sameDocument = (a: string, b: string): boolean => {
  if (a.length < 6 || b.length < 6) {
    return false;
  }
  return (
    a === b ||
    (a.length === b.length + 1 && a.startsWith(b)) ||
    (b.length === a.length + 1 && b.startsWith(a))
  );
};

/**
 * Resuelve el proveedor que imprime la factura contra los proveedores ACTIVOS
 * del negocio. Se elige solo por documento (NIT) o por nombre idéntico (sin
 * sufijos societarios); lo parecido se pregunta.
 */
export const resolveSupplier = (
  query: { name: string | null; document: string | null },
  suppliers: readonly SupplierRow[],
): SupplierResolution => {
  const digits = documentDigits(query.document ?? query.name);
  if (digits.length >= 6) {
    const by_document = suppliers.filter((supplier) =>
      sameDocument(documentDigits(supplier.doc_number), digits),
    );
    if (by_document.length === 1) {
      return { status: 'ok', supplier: by_document[0], via: 'document' };
    }
    if (by_document.length > 1) {
      return {
        status: 'possible_match',
        candidates: by_document.slice(0, MAX_DOCUMENT_CANDIDATES),
      };
    }
  }

  const wanted = supplierWords(query.name ?? '');
  if (wanted.length === 0) {
    return { status: 'not_found' };
  }
  const key = wanted.join(' ');
  const exact = suppliers.filter(
    (supplier) => supplierWords(supplier.legal_name).join(' ') === key,
  );
  if (exact.length === 1) {
    return { status: 'ok', supplier: exact[0], via: 'name' };
  }
  if (exact.length > 1) {
    return { status: 'possible_match', candidates: exact.slice(0, MAX_DOCUMENT_CANDIDATES) };
  }

  // Parecido en cualquiera de los dos sentidos: la factura dice "DISTRIBUIDORA
  // LA ECONOMÍA S.A.S." y el proveedor está guardado como "La Economía".
  const similar = suppliers
    .map((supplier) => {
      const words = supplierWords(supplier.legal_name);
      const forward = matchCore(wanted, words);
      const backward = matchCore(words, wanted);
      const best = forward.coverage >= backward.coverage ? forward : backward;
      return { supplier, best };
    })
    .filter(({ best }) => best.coverage === 1)
    .sort((a, b) => b.best.quality - a.best.quality || a.best.extra - b.best.extra)
    .map(({ supplier }) => supplier)
    .slice(0, MAX_DOCUMENT_CANDIDATES);

  return similar.length > 0
    ? { status: 'possible_match', candidates: similar }
    : { status: 'not_found' };
};

// ──────────────────────────────────────────────────────────────────────────
// Cálculo de líneas y totales (Big.js, redondeo solo al final)
// ──────────────────────────────────────────────────────────────────────────

export interface PurchaseLineAmounts {
  /** Paquetes comprados (la cantidad facturada). */
  packaging_qty: string;
  /** Costo por paquete, SIN IVA (2 decimales). */
  packaging_price: string;
  /** Unidades mínimas que entran al inventario (paquetes × valor del empaque). */
  unit_qty: string;
  /** Costo por unidad mínima (4 decimales). */
  unit_price: string;
  iva_rate: string;
  subtotal: string;
  iva_amount: string;
  total: string;
}

/**
 * Montos de una línea con la MISMA aritmética de `CreatePurchaseAction`:
 * subtotal = paquetes × costo; IVA = subtotal × tasa / 100; total = suma.
 * La cantidad en unidades mínimas sale del empaque registrado del producto
 * (igual que el formulario de Compras de placepos).
 */
export const computePurchaseLine = (input: {
  quantity: Big;
  unit_cost: Big;
  iva_rate: Big;
  packaging_value: Big;
}): PurchaseLineAmounts => {
  const value = input.packaging_value.gt(0) ? input.packaging_value : new Big(1);
  const subtotal = input.quantity.times(input.unit_cost);
  const iva_amount = subtotal.times(input.iva_rate).div(100);
  return {
    packaging_qty: input.quantity.round(4).toString(),
    packaging_price: input.unit_cost.round(2).toString(),
    unit_qty: input.quantity.times(value).round(4).toString(),
    unit_price: input.unit_cost.div(value).round(4).toString(),
    iva_rate: input.iva_rate.round(2).toString(),
    subtotal: subtotal.round(2).toString(),
    iva_amount: iva_amount.round(2).toString(),
    total: subtotal.plus(iva_amount).round(2).toString(),
  };
};

export interface PurchaseTotals {
  subtotal: string;
  iva_total: string;
  total: string;
}

/** Suma sin redondeo intermedio, como `CreatePurchaseAction`. */
export const computePurchaseTotals = (
  lines: ReadonlyArray<{ quantity: Big; unit_cost: Big; iva_rate: Big }>,
): PurchaseTotals => {
  let subtotal = new Big(0);
  let iva = new Big(0);
  for (const line of lines) {
    const line_subtotal = line.quantity.times(line.unit_cost);
    subtotal = subtotal.plus(line_subtotal);
    iva = iva.plus(line_subtotal.times(line.iva_rate).div(100));
  }
  return {
    subtotal: subtotal.round(2).toString(),
    iva_total: iva.round(2).toString(),
    total: subtotal.plus(iva).round(2).toString(),
  };
};

// ──────────────────────────────────────────────────────────────────────────
// Advertencias
// ──────────────────────────────────────────────────────────────────────────

const formatCop = (value: Big): string =>
  `$ ${value
    .round(0)
    .toFixed(0)
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

/**
 * Advierte si el costo facturado se aleja mucho del de la última compra del
 * mismo producto (en la misma unidad): suele ser una cantidad leída en otra
 * unidad o un precio mal leído.
 */
export const costDeviationWarning = (
  product_name: string,
  unit_cost: Big,
  last_cost: Big | null,
): string | null => {
  if (last_cost === null || last_cost.lte(0)) {
    return null;
  }
  const deviation = unit_cost.minus(last_cost).abs().div(last_cost);
  if (deviation.lte(COST_DEVIATION_THRESHOLD)) {
    return null;
  }
  return `El costo de «${product_name}» (${formatCop(unit_cost)}) es muy distinto al de la última compra (${formatCop(last_cost)}): revisa la cantidad, la unidad o el precio.`;
};

/**
 * Advierte si el total calculado no cuadra con el que imprime la factura. Si
 * se excluyeron ítems, no se compara (por fuerza será menor).
 */
export const documentTotalWarning = (
  computed_total: Big,
  document_total: Big | null,
  has_excluded: boolean,
): string | null => {
  if (document_total === null || document_total.lte(0) || has_excluded) {
    return null;
  }
  const difference = computed_total.minus(document_total).abs();
  if (difference.lte(document_total.times(DOCUMENT_TOTAL_TOLERANCE))) {
    return null;
  }
  return `El total calculado (${formatCop(computed_total)}) no coincide con el total de la factura (${formatCop(document_total)}): revisa cantidades, costos e IVA.`;
};
