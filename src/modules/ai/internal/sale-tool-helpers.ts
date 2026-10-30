import Big from 'big.js';

import { normalizeText, readMoneyArg } from './expense-tool-helpers';

/**
 * Reglas puras de la herramienta de PEDIDOS de Place.
 *
 * Todo lo que decide "qué se factura" vive aquí, sin BD: cómo se leen las
 * cantidades y precios que manda el modelo, qué precio lleva cada línea y cómo
 * se calculan los totales. La matemática es la del POS al pie de la letra
 * (`posLineMath` + `saleSchema` de placepos), con Big.js: el pedido que crea
 * Place debe ser indistinguible del que se arma a mano en la caja.
 *
 * Fail-closed: un dato dudoso NO se interpreta, se rechaza y Place pregunta.
 */

/** Máximo de líneas por pedido preparado con Place. */
export const MAX_SALE_LINES = 40;

/** Máximo de alternativas de nombre por línea. */
export const MAX_LINE_ALTERNATIVES = 4;

/** Cantidad máxima por línea (holgada: 50 kg vendidos por gramo = 50.000). */
export const MAX_LINE_QUANTITY = new Big('1000000');

/** Mismo tope que `CreateSaleLineDto.note`. */
export const MAX_LINE_NOTE_LENGTH = 500;

const MAX_QUERY_LENGTH = 120;

// ──────────────────────────────────────────────────────────────────────────
// Cantidad
// ──────────────────────────────────────────────────────────────────────────

export type QuantityReadResult =
  | { status: 'ok'; quantity: Big }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

/**
 * Cantidad de una línea. NUNCA adivina:
 *   - número JSON finito, > 0, máximo 4 decimales (escala de la columna);
 *   - string solo con dígitos y, como mucho, 2 decimales con punto ("0.5");
 *   - "1.500" (¿mil quinientos o uno y medio?), "1,5", "dos" → inválido: el
 *     modelo debe mandar el número limpio.
 */
export const readQuantityArg = (raw: unknown): QuantityReadResult => {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { status: 'missing' };
  }
  let quantity: Big;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return { status: 'invalid', reason: 'La cantidad no es un número válido.' };
    }
    quantity = new Big(raw);
  } else if (typeof raw === 'string' && /^\d{1,7}(\.\d{1,2})?$/.test(raw.trim())) {
    quantity = new Big(raw.trim());
  } else {
    return {
      status: 'invalid',
      reason: 'La cantidad debe ser un número (ej. 2 o 0.5). Confirma con el usuario la cantidad.',
    };
  }
  if (quantity.lte(0)) {
    return { status: 'invalid', reason: 'La cantidad debe ser mayor a cero.' };
  }
  if (!quantity.round(4).eq(quantity)) {
    return { status: 'invalid', reason: 'La cantidad admite máximo 4 decimales.' };
  }
  if (quantity.gt(MAX_LINE_QUANTITY)) {
    return { status: 'invalid', reason: 'La cantidad supera el máximo permitido.' };
  }
  return { status: 'ok', quantity };
};

// ──────────────────────────────────────────────────────────────────────────
// Líneas pedidas
// ──────────────────────────────────────────────────────────────────────────

export interface SaleItemRequest {
  /** Posición (1..n) tal como la pidió el usuario. */
  position: number;
  /** Cómo nombró el producto el usuario. */
  query: string | null;
  /** Otros nombres del mismo producto que propone el modelo (sinónimos). */
  alternatives: string[];
  /** Id elegido de una lista que ya se le mostró al usuario. */
  product_id: number | null;
  quantity: QuantityReadResult;
  /** Nivel de precio por nombre ("mayorista"). `null` = el del POS (el primero). */
  price_level: string | null;
  /** Precio unitario escrito por el usuario (precio manual). */
  unit_price:
    | { status: 'ok'; amount: Big }
    | { status: 'missing' }
    | { status: 'invalid'; reason: string };
  note: string | null;
}

export type SaleItemsReadResult =
  | { status: 'ok'; items: SaleItemRequest[] }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

const readText = (raw: unknown, max: number): string | null => {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim().replace(/\s+/g, ' ');
  return value.length > 0 ? value.slice(0, max) : null;
};

/** `null` = no vino; `'invalid'` = vino pero no es un id entero positivo. */
export const readPositiveId = (raw: unknown): number | null | 'invalid' => {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  const cleaned = text.trim().replace(/^#/, '');
  if (
    !/^\d{1,18}$/.test(cleaned) ||
    Number(cleaned) <= 0 ||
    !Number.isSafeInteger(Number(cleaned))
  ) {
    return 'invalid';
  }
  return Number(cleaned);
};

/**
 * Precio manual de una línea: mismas reglas que un monto de gasto
 * (`readMoneyArg`): número limpio, > 0, máximo 2 decimales; "50.000" o
 * "50 mil" como texto se rechazan.
 */
const readUnitPriceArg = (raw: unknown): SaleItemRequest['unit_price'] => {
  const read = readMoneyArg({ value: raw }, 'value');
  if (read.status === 'ok') {
    return { status: 'ok', amount: read.amount };
  }
  if (read.status === 'missing') {
    return { status: 'missing' };
  }
  return { status: 'invalid', reason: read.reason.replace('del gasto', 'del precio') };
};

/**
 * Lee el arreglo `items` del modelo. Rechaza la forma (no es arreglo, vacío,
 * demasiado largo, un id basura); los datos de cada línea (cantidad, precio)
 * se reportan línea por línea para que Place pregunte solo lo que falta.
 */
export const readSaleItemsArg = (args: Record<string, unknown>): SaleItemsReadResult => {
  const raw = args?.items;
  if (raw === undefined || raw === null) {
    return { status: 'missing' };
  }
  if (!Array.isArray(raw)) {
    return { status: 'invalid', reason: 'Los productos deben venir como una lista.' };
  }
  if (raw.length === 0) {
    return { status: 'missing' };
  }
  if (raw.length > MAX_SALE_LINES) {
    return {
      status: 'invalid',
      reason: `Un pedido con Place admite máximo ${MAX_SALE_LINES} productos. Divídelo en varios pedidos.`,
    };
  }

  const items: SaleItemRequest[] = [];
  for (const [index, entry] of raw.entries()) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const product_id = readPositiveId(item.product_id);
    if (product_id === 'invalid') {
      return {
        status: 'invalid',
        reason: `La referencia del producto ${index + 1} no es válida. Usa el product_id de la lista que devolvió la herramienta.`,
      };
    }
    const alternatives = Array.isArray(item.alternatives)
      ? item.alternatives
          .map((alternative) => readText(alternative, MAX_QUERY_LENGTH))
          .filter((alternative): alternative is string => alternative !== null)
          .slice(0, MAX_LINE_ALTERNATIVES)
      : [];
    const unit_price = readUnitPriceArg(item.unit_price);

    items.push({
      position: index + 1,
      query: readText(item.query, MAX_QUERY_LENGTH),
      alternatives,
      product_id,
      quantity: readQuantityArg(item.quantity),
      price_level: readText(item.price_level, MAX_QUERY_LENGTH),
      unit_price,
      note: readText(item.note, MAX_LINE_NOTE_LENGTH),
    });
  }
  return { status: 'ok', items };
};

// ──────────────────────────────────────────────────────────────────────────
// Precio de una línea
// ──────────────────────────────────────────────────────────────────────────

export interface SellablePrice {
  id: number;
  name: string;
  sale_price: Big;
}

/** Lo que se necesita de un producto para facturarlo. */
export interface SellableProduct {
  id: number;
  name: string;
  product_type: string;
  cost: Big;
  stock: Big;
  parent_id: number | null;
  parent_stock: Big | null;
  packaging_name: string | null;
  packaging_value: Big | null;
  /** En el orden del POS (`ORDER BY pp.id`): el índice es `price_position`. */
  prices: SellablePrice[];
}

/** Fila de `buildSellableDetailsSql` (decimales como string, tal cual pg). */
export interface SellableDetailRow {
  id: string;
  name: string;
  sku_code: string | null;
  bar_code: string | null;
  product_type: string;
  cost: string;
  stock: string;
  parent_id: string | null;
  parent_stock: string | null;
  packaging_name: string | null;
  packaging_value: string | null;
  prices: Array<{ id: string | number; name: string; sale_price: string }>;
}

/** Fila de detalle → producto vendible (Big exactos). */
export const toSellableProduct = (row: SellableDetailRow): SellableProduct => ({
  id: Number(row.id),
  name: row.name,
  product_type: row.product_type,
  cost: new Big(row.cost ?? 0),
  stock: new Big(row.stock ?? 0),
  parent_id: row.parent_id !== null ? Number(row.parent_id) : null,
  parent_stock: row.parent_stock !== null ? new Big(row.parent_stock) : null,
  packaging_name: row.packaging_name,
  packaging_value: row.packaging_value !== null ? new Big(row.packaging_value) : null,
  prices: (row.prices ?? []).map((price) => ({
    id: Number(price.id),
    name: price.name ?? '',
    sale_price: new Big(price.sale_price ?? 0),
  })),
});

export type LinePriceMode = 'fixed' | 'manual';

/**
 * Línea lista para el pedido. Decimales como string exacto (nunca float): es
 * lo que se guarda en la pendiente y lo que se compara al confirmar.
 */
export interface PricedLine {
  product_id: number;
  name: string;
  /** 4 decimales. */
  quantity: string;
  /** 2 decimales. */
  unit_price: string;
  /** Costo unitario (2 decimales). */
  cost: string;
  price_mode: LinePriceMode;
  price_position: number | null;
  /** Nivel de precio usado ("Base", "Mayorista") o "Precio manual". */
  price_label: string;
  total: string;
  profit: string;
  /** Margen de la línea, 4 decimales. */
  margin: string;
  note: string | null;
}

export type LinePriceResult =
  | { status: 'ok'; line: PricedLine }
  | {
      status: 'no_prices' | 'price_level_not_found' | 'below_cost' | 'below_min_margin';
      message: string;
      price_levels?: Array<{ name: string; price: number }>;
    };

/** Margen ((precio − costo) / precio × 100) a 4 decimales, como el POS. */
export const marginFromPrices = (price: Big, cost: Big): Big =>
  price.lte(0) ? new Big(0) : price.minus(cost).div(price).times(100).round(4);

const describeLevels = (prices: readonly SellablePrice[]): Array<{ name: string; price: number }> =>
  prices.map((price) => ({ name: price.name, price: price.sale_price.round(2).toNumber() }));

/** Nivel de precio por nombre: exacto (sin tildes ni mayúsculas) o parcial único. */
const findPriceLevel = (
  prices: readonly SellablePrice[],
  wanted: string,
): { price: SellablePrice; position: number } | null => {
  const target = normalizeText(wanted);
  if (target.length === 0) {
    return null;
  }
  const exact = prices.findIndex((price) => normalizeText(price.name) === target);
  if (exact >= 0) {
    return { price: prices[exact], position: exact };
  }
  const partial = prices
    .map((price, position) => ({ price, position }))
    .filter(({ price }) => {
      const name = normalizeText(price.name);
      return name.length > 0 && (name.includes(target) || target.includes(name));
    });
  return partial.length === 1 ? partial[0] : null;
};

export interface PriceLineInput {
  product: SellableProduct;
  quantity: Big;
  price_level: string | null;
  manual_price: Big | null;
  note: string | null;
  /** Margen mínimo configurado (`pos_margins`), `null` si la regla está apagada. */
  minimum_margin: number | null;
}

/**
 * Precio de la línea, con la matemática exacta del POS:
 *   total  = round2(precio × cantidad)
 *   profit = round2(round2(precio − costo) × cantidad)
 *   margin = round4((precio − costo) / precio × 100)
 *
 * Reglas:
 *   - Sin nivel ni precio manual → el PRIMER precio del producto (el que pone
 *     el POS al agregarlo).
 *   - Precio manual: nunca por debajo del costo (misma regla del POS) ni del
 *     margen mínimo configurado.
 */
export const priceLine = (input: PriceLineInput): LinePriceResult => {
  const { product, quantity, price_level, manual_price, note, minimum_margin } = input;
  const cost = product.cost.round(2);

  let unit_price: Big;
  let price_mode: LinePriceMode;
  let price_position: number | null;
  let price_label: string;

  if (manual_price !== null) {
    unit_price = manual_price.round(2);
    price_mode = 'manual';
    price_position = null;
    price_label = 'Precio manual';
    if (unit_price.lt(cost)) {
      return {
        status: 'below_cost',
        message: `El precio manual de ${product.name} está por debajo de su costo. El POS no permite vender bajo el costo.`,
      };
    }
    const margin = marginFromPrices(unit_price, cost);
    if (minimum_margin !== null && margin.lt(minimum_margin)) {
      return {
        status: 'below_min_margin',
        message: `Con ese precio, ${product.name} queda con margen de ${margin.round(2).toString()}%, por debajo del mínimo configurado (${minimum_margin}%).`,
      };
    }
  } else {
    if (product.prices.length === 0) {
      return {
        status: 'no_prices',
        message: `${product.name} no tiene precios de venta configurados. Pídele al usuario un precio manual o que lo configure en Inventario.`,
      };
    }
    const level =
      price_level === null
        ? { price: product.prices[0], position: 0 }
        : findPriceLevel(product.prices, price_level);
    if (level === null) {
      return {
        status: 'price_level_not_found',
        message: `${product.name} no tiene un nivel de precio "${price_level ?? ''}".`,
        price_levels: describeLevels(product.prices),
      };
    }
    unit_price = level.price.sale_price.round(2);
    price_mode = 'fixed';
    price_position = level.position;
    price_label = level.price.name.trim() || `Precio ${level.position + 1}`;
  }

  const unit_profit = unit_price.minus(cost).round(2);
  return {
    status: 'ok',
    line: {
      product_id: product.id,
      name: product.name,
      quantity: quantity.toFixed(4),
      unit_price: unit_price.toFixed(2),
      cost: cost.toFixed(2),
      price_mode,
      price_position,
      price_label,
      total: unit_price.times(quantity).round(2).toFixed(2),
      profit: unit_profit.times(quantity).round(2).toFixed(2),
      margin: marginFromPrices(unit_price, cost).toFixed(4),
      note,
    },
  };
};

/**
 * Une las líneas del MISMO producto al MISMO precio (y modo), como hace el
 * carrito del POS: dos menciones de "1 libra de fécula" son una línea de 2.
 * Recalcula total/ganancia con la cantidad sumada. Conserva el orden de la
 * primera aparición.
 */
export const mergePricedLines = (lines: readonly PricedLine[]): PricedLine[] => {
  const merged: PricedLine[] = [];
  for (const line of lines) {
    const existing = merged.find(
      (other) =>
        other.product_id === line.product_id &&
        other.price_mode === line.price_mode &&
        new Big(other.unit_price).eq(line.unit_price) &&
        other.note === line.note,
    );
    if (!existing) {
      merged.push({ ...line });
      continue;
    }
    const quantity = new Big(existing.quantity).plus(line.quantity);
    const unit_profit = new Big(existing.unit_price).minus(existing.cost).round(2);
    existing.quantity = quantity.toFixed(4);
    existing.total = new Big(existing.unit_price).times(quantity).round(2).toFixed(2);
    existing.profit = unit_profit.times(quantity).round(2).toFixed(2);
  }
  return merged;
};

export interface SaleTotals {
  total: string;
  cost: string;
  profit: string;
  /** 2 decimales, como `saleSchema` del POS. */
  margin: string;
}

/**
 * Totales del pedido (espejo de `saleSchema` del POS):
 *   cost = round2(Σ costo × cantidad), total = round2(Σ totales),
 *   profit = total − cost, margin = round2(profit / total × 100).
 */
export const computeSaleTotals = (lines: readonly PricedLine[]): SaleTotals => {
  const total = lines.reduce((sum, line) => sum.plus(line.total), new Big(0)).round(2);
  const cost = lines
    .reduce((sum, line) => sum.plus(new Big(line.cost).times(line.quantity)), new Big(0))
    .round(2);
  const profit = total.minus(cost).round(2);
  const margin = total.gt(0) ? profit.div(total).times(100).round(2) : new Big(0);
  return {
    total: total.toFixed(2),
    cost: cost.toFixed(2),
    profit: profit.toFixed(2),
    margin: margin.toFixed(2),
  };
};

/**
 * Existencias en la unidad del producto (la que ve el usuario en Inventario):
 * stock en unidad mínima ÷ factor de empaque; las presentaciones leen el stock
 * del padre. Misma fórmula que `computeStockDisplay`/`computeChildStockDisplay`.
 * `null` para combos (su disponibilidad depende de la receta).
 */
export const availableUnits = (product: SellableProduct): Big | null => {
  if (product.product_type === 'COMBO') {
    return null;
  }
  const factor =
    product.packaging_value !== null && product.packaging_value.gt(0)
      ? product.packaging_value
      : null;
  if (product.parent_id !== null && product.parent_stock !== null && factor !== null) {
    return product.parent_stock.div(factor).round(4);
  }
  return factor !== null ? product.stock.div(factor).round(4) : product.stock;
};

/** Huella de lo que el usuario VIO de una línea (para comparar al confirmar). */
export const visibleLineKey = (line: PricedLine): string =>
  [
    line.product_id,
    line.name,
    line.quantity,
    line.unit_price,
    line.price_mode,
    // El nivel también se mostró ("Base", "Mayorista"): si cambió, cambió.
    line.price_label,
    line.total,
  ].join('|');
