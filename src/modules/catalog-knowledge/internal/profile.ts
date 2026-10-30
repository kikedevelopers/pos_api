import { createHash } from 'crypto';

/**
 * Ficha "Para el asistente" de un producto: tipos, saneo y el texto que se
 * indexa para la búsqueda por significado. Funciones puras (sin BD ni red).
 */

export interface ProductAttribute {
  name: string;
  value: string;
}

/** Relación con otro producto, vista desde ESTE producto. */
export type RelatedKind = 'complement' | 'upgrade' | 'alternative';

export const RELATED_KINDS: readonly RelatedKind[] = ['complement', 'upgrade', 'alternative'];

export interface RelatedProductRef {
  product_id: number;
  kind: RelatedKind;
}

/** Ficha editable (lo que viaja en el API). */
export interface AssistantProfileInput {
  description: string;
  uses: string[];
  attributes: ProductAttribute[];
  aliases: string[];
  related: RelatedProductRef[];
}

export const PROFILE_LIMITS = {
  description: 1000,
  listItems: 15,
  tag: 60,
  attributes: 15,
  attributeName: 40,
  attributeValue: 80,
  related: 10,
} as const;

export const EMPTY_PROFILE: AssistantProfileInput = {
  description: '',
  uses: [],
  attributes: [],
  aliases: [],
  related: [],
};

const cleanText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Lista de etiquetas: recortadas, sin vacías ni repetidas (sin importar mayúsculas). */
export const sanitizeTags = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    const tag = cleanText(item, PROFILE_LIMITS.tag);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(tag);
    if (tags.length >= PROFILE_LIMITS.listItems) {
      break;
    }
  }
  return tags;
};

export const sanitizeAttributes = (raw: unknown): ProductAttribute[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const attributes: ProductAttribute[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = cleanText(record.name, PROFILE_LIMITS.attributeName);
    const value = cleanText(
      typeof record.value === 'number' ? String(record.value) : record.value,
      PROFILE_LIMITS.attributeValue,
    );
    const key = name.toLowerCase();
    if (!name || !value || seen.has(key)) {
      continue;
    }
    seen.add(key);
    attributes.push({ name, value });
    if (attributes.length >= PROFILE_LIMITS.attributes) {
      break;
    }
  }
  return attributes;
};

/** Relacionados válidos: ids positivos, tipo conocido, sin sí mismo ni repetidos. */
export const sanitizeRelated = (raw: unknown, selfId: number): RelatedProductRef[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<number>();
  const related: RelatedProductRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const productId = Number(record.product_id);
    const kind = record.kind as RelatedKind;
    if (
      !Number.isSafeInteger(productId) ||
      productId <= 0 ||
      productId === selfId ||
      !RELATED_KINDS.includes(kind) ||
      seen.has(productId)
    ) {
      continue;
    }
    seen.add(productId);
    related.push({ product_id: productId, kind });
    if (related.length >= PROFILE_LIMITS.related) {
      break;
    }
  }
  return related;
};

export const sanitizeProfile = (
  raw: Partial<Record<keyof AssistantProfileInput, unknown>>,
  selfId: number,
): AssistantProfileInput => ({
  description:
    typeof raw.description === 'string'
      ? raw.description.trim().slice(0, PROFILE_LIMITS.description)
      : '',
  uses: sanitizeTags(raw.uses),
  attributes: sanitizeAttributes(raw.attributes),
  aliases: sanitizeTags(raw.aliases),
  related: sanitizeRelated(raw.related, selfId),
});

/** `true` si la ficha no aporta nada (todo vacío). */
export const isProfileEmpty = (profile: AssistantProfileInput): boolean =>
  !profile.description &&
  profile.uses.length === 0 &&
  profile.attributes.length === 0 &&
  profile.aliases.length === 0 &&
  profile.related.length === 0;

/** Lo que se sabe de una familia para indexarla. */
export interface FamilyIndexSource {
  name: string;
  category: string | null;
  presentations: string[];
  profile: Pick<AssistantProfileInput, 'description' | 'uses' | 'attributes' | 'aliases'> | null;
}

/**
 * Texto que representa a la familia para el vector de significado. Determinista
 * (mismo orden siempre) para que el hash solo cambie cuando cambia el contenido.
 */
export const buildFamilyText = (source: FamilyIndexSource): string => {
  const lines = [`Producto: ${source.name.trim()}`];
  if (source.category?.trim()) {
    lines.push(`Categoría: ${source.category.trim()}`);
  }
  const presentations = [...new Set(source.presentations.map((p) => p.trim()).filter(Boolean))]
    .filter((p) => p.toLowerCase() !== source.name.trim().toLowerCase())
    .sort();
  if (presentations.length > 0) {
    lines.push(`Presentaciones: ${presentations.join('; ')}`);
  }
  const profile = source.profile;
  if (profile) {
    if (profile.description.trim()) {
      lines.push(`Descripción: ${profile.description.trim()}`);
    }
    if (profile.uses.length > 0) {
      lines.push(`Sirve para: ${profile.uses.join(', ')}`);
    }
    if (profile.attributes.length > 0) {
      lines.push(
        `Características: ${profile.attributes.map((a) => `${a.name}: ${a.value}`).join('; ')}`,
      );
    }
    if (profile.aliases.length > 0) {
      lines.push(`También lo llaman: ${profile.aliases.join(', ')}`);
    }
  }
  return lines.join('\n');
};

export const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Normaliza a norma 1 (las dimensiones reducidas de Gemini no vienen normalizadas). */
export const normalizeVector = (values: readonly number[]): number[] => {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? values.map((v) => v / norm) : values.map(() => 0);
};

/** Producto punto (= coseno si ambos están normalizados). */
export const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
};

export interface ScoredId {
  id: number;
  score: number;
}

/**
 * Los `limit` más parecidos, de mayor a menor. Pasan los que superan `minScore`
 * Y quedan cerca del mejor (a no más de `window`): los puntajes de Gemini son
 * muy apretados, así que un umbral fijo solo deja pasar ruido junto a lo bueno.
 */
export const topMatches = (
  query: ArrayLike<number>,
  items: ReadonlyArray<{ id: number; vector: ArrayLike<number> }>,
  limit: number,
  minScore: number,
  window: number = Number.POSITIVE_INFINITY,
): ScoredId[] => {
  const ranked = items
    .map((item) => ({ id: item.id, score: dot(query, item.vector) }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || a.id - b.id);
  const best = ranked[0]?.score ?? 0;
  return ranked.filter((item) => best - item.score <= window).slice(0, limit);
};
