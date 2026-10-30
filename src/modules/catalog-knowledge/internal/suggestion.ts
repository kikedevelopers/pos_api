import {
  PROFILE_LIMITS,
  sanitizeAttributes,
  sanitizeTags,
  type AssistantProfileInput,
} from './profile';

/** Ficha propuesta por la IA (sin relacionados: esos los elige el dueño). */
export type ProfileSuggestion = Pick<
  AssistantProfileInput,
  'description' | 'uses' | 'attributes' | 'aliases'
>;

export interface SuggestionContext {
  name: string;
  category: string | null;
  presentations: string[];
  business: string | null;
}

/**
 * Instrucción para que la IA proponga la ficha. Le pide prudencia: solo lo que
 * se deduce del nombre, nada de medidas o materiales inventados.
 */
export const buildSuggestionPrompt = (context: SuggestionContext): string =>
  [
    'Eres un experto en catálogos de comercio en Colombia. Completa la ficha que usará un vendedor por chat para entender este producto y recomendarlo según la NECESIDAD del cliente.',
    '',
    `Producto: ${context.name}`,
    context.category ? `Categoría: ${context.category}` : null,
    context.presentations.length > 0 ? `Presentaciones: ${context.presentations.join('; ')}` : null,
    context.business ? `Negocio: ${context.business}` : null,
    '',
    'Devuelve SOLO un JSON con esta forma:',
    '{"description": string, "uses": string[], "attributes": [{"name": string, "value": string}], "aliases": string[]}',
    '',
    'Reglas:',
    '- description: 1 o 2 frases en español claro, qué es y para qué se usa. Sin precios ni promesas.',
    '- uses: hasta 6 usos o necesidades que resuelve, cortos ("hamburguesa con papas", "lonchera", "asados").',
    '- attributes: solo características que se DEDUCEN con seguridad del nombre (tamaño, material, cantidad, sabor...). Si no hay certeza, no la pongas. Nunca inventes medidas.',
    '- aliases: hasta 6 nombres con que los clientes lo piden en Colombia (coloquiales, sin repetir el nombre).',
    '- Todo en español, sin emojis ni markdown.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

/**
 * Lee la respuesta de la IA. Tolera bloques ```json``` y texto alrededor.
 * `null` si no trae nada aprovechable.
 */
export const parseProfileSuggestion = (raw: string): ProfileSuggestion | null => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const suggestion: ProfileSuggestion = {
    description:
      typeof record.description === 'string'
        ? record.description.replace(/\s+/g, ' ').trim().slice(0, PROFILE_LIMITS.description)
        : '',
    uses: sanitizeTags(record.uses),
    attributes: sanitizeAttributes(record.attributes),
    aliases: sanitizeTags(record.aliases),
  };
  const empty =
    !suggestion.description &&
    suggestion.uses.length === 0 &&
    suggestion.attributes.length === 0 &&
    suggestion.aliases.length === 0;
  return empty ? null : suggestion;
};
