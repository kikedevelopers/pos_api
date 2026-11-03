import type { SalesBotPersonality } from '../entities/sales-bot-config.entity';
import { greetingPhrase, type TimeOfDay } from './greeting';

/**
 * Seguimiento a un cliente: el agente redacta un saludo PERSONAL (distinto para
 * cada cliente) para retomar el contacto por WhatsApp. Puede recordar algo que
 * el cliente SÍ compró en sus últimas ventas y sugerir productos del catálogo
 * que combinen con eso.
 *
 * Todo lo de este archivo es PURO (sin BD ni red) para poder probarlo:
 *   - `buildFollowUpPrompt` arma la instrucción con el contexto REAL.
 *   - `parseFollowUpDraft` valida la respuesta del modelo: los productos que
 *     menciona deben existir (catálogo) y lo que "recuerda" debe haberlo
 *     comprado de verdad. Si no, el borrador se rechaza (nunca se inventa).
 */

/** Un producto (familia base) que el cliente compró en sus últimas ventas. */
export interface FollowUpPurchasedItem {
  /** Id del producto BASE (las presentaciones se agrupan en su base). */
  id: number;
  name: string;
  category: string | null;
  /** Fecha de la venta más reciente en que lo llevó (YYYY-MM-DD). */
  last_bought: string;
  /** En cuántas de las últimas ventas aparece. */
  times: number;
  /** ¿Hay existencias hoy? (`null` = el negocio no habla de stock). */
  in_stock: boolean | null;
  /** ¿Entró mercancía de ese producto DESPUÉS de que el cliente lo compró? */
  restocked: boolean;
}

/** Un producto del catálogo que el agente PUEDE sugerir. */
export interface FollowUpCatalogItem {
  id: number;
  name: string;
  category: string | null;
  /** Descripción corta de la ficha del asistente (si la hay). */
  description?: string | null;
  /** Ids de productos comprados a los que este COMPLEMENTA según la ficha. */
  complements?: number[];
}

/** Una de las últimas ventas, para que el agente entienda el ritmo. */
export interface FollowUpSaleSummary {
  date: string;
  items: string[];
}

export interface FollowUpPromptInput {
  businessName: string;
  assistantName: string;
  personality: SalesBotPersonality;
  /** Cómo quiere saludar el dueño (texto libre); vacío = tono del preset. */
  greetingStyle?: string;
  customerName: string;
  timeOfDay: TimeOfDay;
  /** Días desde su última compra (para el tono: "hace rato no te vemos"). */
  daysSinceLastPurchase: number | null;
  recentSales: FollowUpSaleSummary[];
  purchased: FollowUpPurchasedItem[];
  catalog: FollowUpCatalogItem[];
  /** Borradores que el humano ya vio y descartó: el nuevo debe ser distinto. */
  previousDrafts?: string[];
  /** `offer_always`: no se habla de existencias ni de "nuevo stock". */
  hideStock: boolean;
}

/** Límite duro del mensaje (WhatsApp lo muestra completo sin "leer más"). */
export const FOLLOW_UP_MAX_LENGTH = 900;
/** Mínimo razonable: un saludo de verdad, no un "hola". */
export const FOLLOW_UP_MIN_LENGTH = 40;
/** Sugerencias máximas por mensaje: más que eso ya es un catálogo, no un saludo. */
export const FOLLOW_UP_MAX_SUGGESTIONS = 3;

const PERSONALITY_TONE: Record<SalesBotPersonality, string> = {
  amable_profesional: 'cálido, cercano y profesional; trato de "tú"',
  directo_comercial: 'ágil y comercial, con energía; trato de "tú"; frases cortas',
  formal_corporativo: 'formal y respetuoso; trato de "usted"; sin jerga',
};

const TIME_OF_DAY_LABEL: Record<TimeOfDay, string> = {
  manana: 'mañana (buenos días)',
  tarde: 'tarde (buenas tardes)',
  noche: 'noche (buenas noches)',
};

/**
 * Nombre "de persona" para un producto del catálogo: sin el empaque ni la
 * medida que el negocio usa para inventario. "GRANOLA X 500g" → "Granola";
 * "ARANDANOS CJ X 11.34K" → "Arandanos"; "ESENCIA PRODEN - AREQUIPE" →
 * "Esencia proden - arequipe". Si limpiar lo deja vacío, se conserva el nombre.
 */
export const naturalProductName = (raw: string): string => {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  const cleaned = trimmed
    .replace(/\s+(?:(?:cj|caja|paq|paquete|bolsa|bto|bulto)\s+)?x(?=\s|\d)[\s\S]*$/i, '')
    .replace(/\s+(?:x\s+)?\d+(?:[.,]\d+)?\s*(?:g|gr|grs|gramos?|kg?|kilos?|lb|libras?|ml|lt?)\.?$/i, '')
    .replace(/\s+(?:paq|paquete|und|unid|unidad|bto|bolsa)\.?$/i, '')
    .trim();
  const base = cleaned || trimmed;
  const lower = base.toLocaleLowerCase('es-CO');
  return lower.charAt(0).toLocaleUpperCase('es-CO') + lower.slice(1);
};

/** Primer nombre en formato título: "ANA MARÍA ORTIZ" → "Ana". */
export const firstNameOf = (fullName: string): string => {
  const first = fullName.trim().split(/\s+/)[0] ?? '';
  if (!first) {
    return '';
  }
  return first.charAt(0).toLocaleUpperCase('es-CO') + first.slice(1).toLocaleLowerCase('es-CO');
};

const describePurchased = (item: FollowUpPurchasedItem, hideStock: boolean): string => {
  const facts = [`id ${item.id}`, `"${naturalProductName(item.name)}"`];
  if (item.category) {
    facts.push(`categoría ${item.category}`);
  }
  facts.push(`lo llevó por última vez el ${item.last_bought}`);
  if (item.times > 1) {
    facts.push(`en ${item.times} de sus últimas compras`);
  }
  if (!hideStock) {
    if (item.in_stock === false) {
      facts.push('HOY SIN EXISTENCIAS (no lo ofrezcas)');
    } else if (item.restocked) {
      facts.push('ENTRÓ MERCANCÍA NUEVA desde que lo compró');
    }
  }
  return `- ${facts.join(' · ')}`;
};

const describeCatalogItem = (item: FollowUpCatalogItem, purchasedNames: Map<number, string>) => {
  const facts = [`id ${item.id}`, `"${naturalProductName(item.name)}"`];
  if (item.category) {
    facts.push(item.category);
  }
  const complements = (item.complements ?? [])
    .map((id) => purchasedNames.get(id))
    .filter((name): name is string => Boolean(name));
  if (complements.length > 0) {
    facts.push(`el negocio dice que COMPLEMENTA a: ${complements.join(', ')}`);
  }
  if (item.description) {
    facts.push(item.description.slice(0, 140));
  }
  return `- ${facts.join(' · ')}`;
};

/**
 * Instrucción completa del seguimiento. El contexto es SOLO lo real: lo que el
 * cliente compró y lo que el negocio tiene; las reglas de oro prohíben salirse
 * de ahí.
 */
export const buildFollowUpPrompt = (input: FollowUpPromptInput): string => {
  const firstName = firstNameOf(input.customerName) || 'el cliente';
  const purchasedNames = new Map(
    input.purchased.map((item) => [item.id, naturalProductName(item.name)]),
  );
  const purchasedBlock =
    input.purchased.length > 0
      ? input.purchased.map((item) => describePurchased(item, input.hideStock)).join('\n')
      : '- (no hay compras registradas con detalle)';
  const salesBlock =
    input.recentSales.length > 0
      ? input.recentSales
          .map((sale) => `- ${sale.date}: ${sale.items.map(naturalProductName).join(', ')}`)
          .join('\n')
      : '- (sin ventas recientes)';
  const catalogBlock =
    input.catalog.length > 0
      ? input.catalog.map((item) => describeCatalogItem(item, purchasedNames)).join('\n')
      : '- (catálogo vacío: NO sugieras productos)';
  const previous = (input.previousDrafts ?? []).filter((draft) => draft.trim().length > 0);
  const previousBlock =
    previous.length > 0
      ? [
          '',
          '## Borradores que el negocio YA DESCARTÓ',
          'Escribe uno claramente DISTINTO: otra apertura, otra estructura, otros emojis y, si hay opciones, otra sugerencia.',
          ...previous.map((draft, index) => `--- Borrador ${index + 1} ---\n${draft.trim()}`),
        ].join('\n')
      : '';
  const recency =
    input.daysSinceLastPurchase === null
      ? 'No se sabe cuándo compró por última vez.'
      : `Su última compra fue hace ${input.daysSinceLastPurchase} día(s).`;

  return [
    `Eres ${input.assistantName}, del equipo de ${input.businessName}. Vas a escribirle por WhatsApp a ${firstName}, un cliente que ya nos ha comprado, para hacerle SEGUIMIENTO: saludarlo, agradecerle su confianza y retomar el contacto.`,
    '',
    '## Tono',
    `- Personalidad: ${PERSONALITY_TONE[input.personality]}.`,
    input.greetingStyle?.trim()
      ? `- Estilo propio del negocio (respétalo): ${input.greetingStyle.trim()}`
      : '- Saludo enganchador y formal a la vez: cercano pero respetuoso.',
    `- Es de ${TIME_OF_DAY_LABEL[input.timeOfDay]} en Colombia.`,
    `- ${recency}`,
    '',
    '## Lo que el cliente SÍ compró (sus últimas ventas)',
    salesBlock,
    '',
    'Productos de esas ventas (agrupados):',
    purchasedBlock,
    '',
    '## Catálogo que PUEDES sugerir',
    catalogBlock,
    '',
    '## Cómo razonar',
    '1. Mira qué compró y piensa qué le serviría o combinaría con eso (p. ej. si llevó uva pasa, arándanos o maní para mezclar). Prioriza los productos que el negocio marcó como complemento.',
    `2. Elige de 0 a ${FOLLOW_UP_MAX_SUGGESTIONS} sugerencias del catálogo. Si nada combina de verdad, no sugieras nada: un saludo sincero vale más que una venta forzada.`,
    input.hideStock
      ? '3. NO hables de existencias, agotados ni "nuevo stock".'
      : '3. Si un producto que compró tiene MERCANCÍA NUEVA, puedes contárselo. Nunca ofrezcas lo que está sin existencias.',
    '4. Varía: cada cliente recibe un mensaje distinto (apertura, estructura y emojis propios).',
    '',
    '## Reglas de oro (no negociables)',
    '- NUNCA inventes productos: solo puedes nombrar productos de las dos listas de arriba.',
    '- NUNCA digas que el cliente compró algo que no está en "Lo que el cliente SÍ compró".',
    '- No menciones precios, descuentos, promociones ni domicilios gratis: no los conoces.',
    '- No digas que eres una IA ni hables de "sistema" o "base de datos".',
    '- Usa nombres naturales ("uvas pasas", no "UVA PASA X 500G").',
    '',
    '## Formato (WhatsApp)',
    `- Primera línea: saludo a ${firstName} por su nombre con un emoji (p. ej. "¡Hola ${firstName}! 👋").`,
    '- OBLIGATORIO: 4 a 5 párrafos MUY cortos (1 o 2 frases cada uno) separados por una línea en blanco (\\n\\n). Nunca un solo bloque de texto.',
    '- Un emoji al inicio o al final de algunos párrafos (entre 3 y 6 en total).',
    '- Resalta con *asteriscos* (negrita de WhatsApp) el nombre del negocio y la frase de cierre.',
    '- Penúltimo párrafo: una pregunta abierta que invite a responder.',
    `- Máximo ${FOLLOW_UP_MAX_LENGTH - 150} caracteres.`,
    '',
    'Ejemplo de ESTILO (no lo copies; el tuyo debe ser distinto y personal):',
    '¡Hola Julio! 👋😊 ¿Cómo estás?',
    '',
    '🌿 Te saludamos de *Esencia & Grano*. Esperamos que estés teniendo un excelente día. ✨',
    '',
    'Pasamos a saludarte, agradecerte por confiar en nosotros y recordarte que siempre estamos felices de atenderte. 🛍️',
    '',
    '💬 Cuéntanos, ¿cómo has estado? ¿Hay algo en lo que podamos ayudarte hoy?',
    '',
    '💜 *¡Siempre es un gusto saber de ti!*',
    previousBlock,
    '',
    '## Respuesta',
    'Devuelve SOLO el JSON del esquema: `message` (el texto final), `recalled_product_ids` (ids de "Lo que el cliente SÍ compró" que mencionas) y `suggested_product_ids` (ids del catálogo que sugieres). Si no mencionas ninguno, listas vacías.',
  ].join('\n');
};

/** Esquema de salida estructurada (Gemini `responseSchema`). */
export const FOLLOW_UP_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    message: { type: 'STRING' },
    recalled_product_ids: { type: 'ARRAY', items: { type: 'INTEGER' } },
    suggested_product_ids: { type: 'ARRAY', items: { type: 'INTEGER' } },
  },
  required: ['message', 'recalled_product_ids', 'suggested_product_ids'],
} as const;

export interface FollowUpDraft {
  message: string;
  recalled_product_ids: number[];
  suggested_product_ids: number[];
}

export type FollowUpParseResult =
  | { ok: true; draft: FollowUpDraft }
  | { ok: false; reason: string };

export interface FollowUpAllowedIds {
  purchased: ReadonlySet<number>;
  catalog: ReadonlySet<number>;
  /** Comprados que hoy no tienen existencias (no se pueden "recordar" como oferta). */
  outOfStock?: ReadonlySet<number>;
}

/** Quita bloques ```json … ``` por si el modelo los agrega. */
const stripFences = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

const readIds = (raw: unknown): number[] | null => {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const ids: number[] = [];
  for (const value of raw) {
    const id = typeof value === 'string' ? Number(value) : value;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      return null;
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
};

/** Saltos de línea normalizados y sin espacios sobrantes por párrafo. */
export const normalizeFollowUpMessage = (message: string): string =>
  message
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Valida la respuesta del modelo contra el contexto REAL. Cualquier id fuera de
 * las listas significa que el modelo se salió del contexto: se rechaza el
 * borrador completo (el servicio pide otro), nunca se "corrige" a ciegas.
 */
export const parseFollowUpDraft = (
  rawText: string,
  allowed: FollowUpAllowedIds,
): FollowUpParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(rawText));
  } catch {
    return { ok: false, reason: 'La respuesta no es un JSON válido.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'La respuesta no es un objeto.' };
  }
  const record = parsed as Record<string, unknown>;
  const message =
    typeof record.message === 'string' ? normalizeFollowUpMessage(record.message) : '';
  if (message.length < FOLLOW_UP_MIN_LENGTH) {
    return { ok: false, reason: 'El mensaje está vacío o es demasiado corto.' };
  }
  if (message.length > FOLLOW_UP_MAX_LENGTH) {
    return {
      ok: false,
      reason: `El mensaje supera ${FOLLOW_UP_MAX_LENGTH} caracteres; hazlo más corto.`,
    };
  }

  const recalled = readIds(record.recalled_product_ids);
  const suggested = readIds(record.suggested_product_ids);
  if (!recalled || !suggested) {
    return { ok: false, reason: 'Las listas de ids no son válidas.' };
  }
  const invented = recalled.filter((id) => !allowed.purchased.has(id));
  if (invented.length > 0) {
    return {
      ok: false,
      reason: `Mencionaste como comprados productos que el cliente NO compró (ids ${invented.join(', ')}).`,
    };
  }
  const unknown = suggested.filter((id) => !allowed.catalog.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `Sugeriste productos que no están en el catálogo (ids ${unknown.join(', ')}).`,
    };
  }
  const soldOut = suggested.filter((id) => allowed.outOfStock?.has(id));
  if (soldOut.length > 0) {
    return {
      ok: false,
      reason: `Sugeriste productos sin existencias (ids ${soldOut.join(', ')}).`,
    };
  }
  if (suggested.length > FOLLOW_UP_MAX_SUGGESTIONS) {
    return {
      ok: false,
      reason: `Máximo ${FOLLOW_UP_MAX_SUGGESTIONS} sugerencias por mensaje.`,
    };
  }

  return { ok: true, draft: { message, recalled_product_ids: recalled, suggested_product_ids: suggested } };
};

/**
 * Saludo de respaldo, SIN productos (si la IA falla dos veces): cumple el
 * seguimiento sin arriesgarse a inventar nada.
 */
export const fallbackFollowUpMessage = (input: {
  customerName: string;
  businessName: string;
  assistantName: string;
  personality: SalesBotPersonality;
  timeOfDay: TimeOfDay;
}): string => {
  const name = firstNameOf(input.customerName);
  const hello = greetingPhrase(input.timeOfDay);
  if (input.personality === 'formal_corporativo') {
    return [
      `${hello}${name ? `, ${name}` : ''}. 👋`,
      `Le saluda ${input.assistantName}, de *${input.businessName}*. Queremos agradecerle por confiar en nosotros.`,
      'Quedamos atentos a lo que necesite. ¿Hay algo en lo que podamos ayudarle hoy?',
    ].join('\n\n');
  }
  return [
    `¡${hello}${name ? `, ${name}` : ''}! 👋😊`,
    `Te saluda ${input.assistantName}, de *${input.businessName}*. Pasamos a saludarte y a agradecerte por confiar en nosotros. ✨`,
    '¿Cómo has estado? ¿Hay algo en lo que te podamos ayudar hoy? 💬',
  ].join('\n\n');
};
