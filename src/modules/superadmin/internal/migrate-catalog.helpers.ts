import { calculateMargin, calculateProfit, toBig } from '@/common/utils/precision';

/**
 * Tipos de wire (request body de
 * `POST /superadmin/tenants/:companyId/migrate-catalog`).
 *
 * El panel kdevs-admin MAPEA la forma Mongo a estos shapes (funciones puras en
 * `map.ts`), aplica los filtros de exclusión y hace dedupe interno. pos_api es
 * la AUTORIDAD de la idempotencia (dedupe por nombre contra la BD) y aplica los
 * mismos filtros de forma defensiva. Ver `docs`/contrato de migración.
 */
export interface MigrateCatalogPriceInput {
  name?: string | null;
  sale_price: number;
  iva_percentage?: number | null;
}

export interface MigrateCatalogProductInput {
  /** `_id` de Mongo (hex). Llave estable para linkage base↔presentación y logs. */
  srcId: string;
  name: string;
  sku_code?: string | null;
  bar_code?: string | null;
  cost: number;
  stock: number;
  /** `null` = base; presentación → `srcId` del base. */
  parentSrcId?: string | null;
  category?: string | null;
  packaging?: { name: string; value: number } | null;
  prices: MigrateCatalogPriceInput[];
}

export interface MigrateCatalogCustomerInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  doc_number?: string | null;
  address?: string | null;
}

export interface MigrateCatalogBody {
  meta?: { email?: string; businessName?: string; mongoBusinessId?: string };
  products: MigrateCatalogProductInput[];
  customers: MigrateCatalogCustomerInput[];
}

export interface MigrateCatalogResult {
  business?: { name?: string; mongoId?: string };
  products: {
    inserted: number;
    skippedExisting: number;
    skippedDuplicate: number;
    skippedOrphan: number;
    skippedInvalid: number;
  };
  presentations: { inserted: number; skipped: number };
  categories: { created: number; reused: number };
  packagings: { created: number; reused: number };
  customers: { inserted: number; skippedExisting: number; skippedDuplicate: number };
  prices: { inserted: number };
}

/**
 * Llave de dedupe/lookup por nombre: `lower(btrim(name))`. Espejo EXACTO de los
 * índices únicos parciales de Postgres (`idx_*_company_name_unique`), que usan
 * `lower(btrim(name))`. `btrim` recorta espacios en blanco a ambos lados y JS
 * `trim()` hace lo mismo para whitespace ASCII/Unicode.
 */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Normaliza un string opcional del wire: `trim`; cadena vacía → `null`. Se usa
 * para `sku_code`/`bar_code`/`email`/`phone`/`doc_number`/`address`. `null`/
 * `undefined` → `null`.
 */
export function sanitizeString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Regex de "nombre basura" del contrato (case-insensitive, con límites de
 * palabra). Espejo del filtro de exclusión de kdevs `map.ts`.
 */
const GARBAGE_NAME_RE = /\b(vacio|vacío|borrado|no existe)\b/i;

/**
 * Un producto es INVÁLIDO (excluido, `skippedInvalid`) si:
 *   - nombre vacío / solo espacios, o
 *   - nombre "basura" (regex), o
 *   - sin precio válido: `prices` vacío o TODOS los `sale_price <= 0`.
 *
 * Defensa en profundidad: kdevs ya filtró estos, pero pos_api NO confía en el
 * cliente.
 */
export function isInvalidProduct(product: MigrateCatalogProductInput): boolean {
  const name = (product.name ?? '').trim();
  if (name.length === 0) {
    return true;
  }
  if (GARBAGE_NAME_RE.test(name)) {
    return true;
  }
  return !hasValidPrice(product.prices);
}

/** `true` si al menos un precio tiene `sale_price > 0`. */
export function hasValidPrice(prices: MigrateCatalogPriceInput[] | null | undefined): boolean {
  if (!Array.isArray(prices) || prices.length === 0) {
    return false;
  }
  return prices.some((p) => toBig(p?.sale_price).gt(0));
}

/**
 * Filtra los precios válidos (`sale_price > 0`) preservando el orden, e ignora
 * los no positivos. El `iva_percentage` se normaliza a `[0, 100]` (fuera de
 * rango → 0, para no violar el CHECK de la columna).
 */
export function validPrices(
  prices: MigrateCatalogPriceInput[] | null | undefined,
): MigrateCatalogPriceInput[] {
  if (!Array.isArray(prices)) {
    return [];
  }
  return prices.filter((p) => toBig(p?.sale_price).gt(0));
}

/**
 * Fila de inserción de un `product_prices` con `profit`/`margin` RECALCULADOS
 * con Big.js (fuente única de verdad servidor; el hint del cliente se IGNORA).
 * `iva_percentage` fuera de `[0, 100]` → 0.
 */
export interface MigratePriceRow {
  name: string;
  sale_price: number;
  profit: number;
  margin: number;
  iva_percentage: number;
}

export function buildMigratePriceRow(
  input: MigrateCatalogPriceInput,
  cost: number,
): MigratePriceRow {
  const iva = toBig(input.iva_percentage ?? 0);
  const safeIva = iva.gte(0) && iva.lte(100) ? Number(iva.toString()) : 0;
  return {
    name: (input.name ?? '').trim(),
    sale_price: input.sale_price,
    profit: calculateProfit(input.sale_price, cost),
    margin: calculateMargin(input.sale_price, cost),
    iva_percentage: safeIva,
  };
}

/**
 * Nombre canónico determinista de un empaque, para respetar el UNIQUE de nombre
 * por company. Regla del contrato:
 *   - Si el nombre está LIBRE (o ya registrado con el MISMO value) → úsalo tal
 *     cual (trim; vacío → 'EMPAQUE').
 *   - Si el nombre ya está tomado por OTRO value → `"${name} × ${value}"`.
 *
 * `takenNameValue` mapea `nameKey → value` de los empaques ya conocidos (los de
 * la BD + los ya decididos en este batch). La comparación de `value` es exacta
 * vía Big.js (evita falsos negativos por IEEE-754).
 */
export function canonicalPackagingName(
  rawName: string,
  value: number,
  takenNameValue: Map<string, number>,
): string {
  const base = rawName.trim() || 'EMPAQUE';
  const baseKey = nameKey(base);
  const existing = takenNameValue.get(baseKey);
  if (existing === undefined || toBig(existing).eq(toBig(value))) {
    return base;
  }
  return `${base} × ${value}`;
}

/** Llave de dedupe de empaque por (nombre, value): `${nameKey}|${value}`. */
export function packagingKey(name: string, value: number): string {
  return `${nameKey(name)}|${toBig(value).toString()}`;
}

/**
 * Dedupe genérico "primer visto gana" por una llave derivada. Devuelve los
 * elementos ÚNICOS (primera aparición, orden preservado) y los DUPLICADOS
 * (apariciones posteriores con una llave ya vista). Útil para el dedupe interno
 * del batch antes de tocar la BD.
 */
export function dedupeByKey<T>(
  items: T[],
  keyOf: (item: T) => string,
): { unique: T[]; duplicates: T[] } {
  const seen = new Set<string>();
  const unique: T[] = [];
  const duplicates: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      duplicates.push(item);
    } else {
      seen.add(key);
      unique.push(item);
    }
  }
  return { unique, duplicates };
}
