import { ASSISTANT_NAME } from './system-prompt';
import type { AiToolName } from './tool-catalog';

/**
 * Saludo de bienvenida de Place — el texto que abre el chat.
 *
 * Todo puro y testeado porque este texto lo escribe un modelo, y a un modelo hay
 * que tratarlo como a una entrada no confiable: puede devolver markdown, tres
 * párrafos, emojis o inventarse el nombre del negocio. Lo que no cumpla las
 * reglas se descarta y se cae al saludo fijo — mejor un saludo correcto de
 * siempre que uno "creativo" que mienta.
 */

/** Tope duro del saludo. Es una línea, no un párrafo. */
export const MAX_GREETING_LENGTH = 220;

/** Mínimo razonable: por debajo de esto el modelo no dijo nada útil. */
const MIN_GREETING_LENGTH = 40;

/**
 * Áreas de las que Place puede hablar, deducidas de las herramientas que el
 * actor tiene permitidas. Sin esto el saludo prometería informes que el usuario
 * no puede ver.
 */
const TOPIC_BY_TOOL: Partial<Record<AiToolName, string>> = {
  get_daily_summary: 'ventas',
  list_sales: 'ventas',
  get_performance_range: 'ventas',
  get_top_products: 'ventas',
  search_products: 'inventario',
  get_low_stock: 'inventario',
  get_debtors: 'cartera',
  search_customers: 'clientes',
  get_expenses_summary: 'gastos',
  get_treasury_accounts: 'caja',
};

/** Orden fijo: así el saludo suena igual de ordenado siempre. */
const TOPIC_ORDER = ['ventas', 'caja', 'inventario', 'cartera', 'clientes', 'gastos'];

export const describeTopics = (toolNames: readonly string[]): string[] => {
  const topics = new Set<string>();
  for (const name of toolNames) {
    const topic = TOPIC_BY_TOOL[name as AiToolName];
    if (topic) {
      topics.add(topic);
    }
  }
  return TOPIC_ORDER.filter((topic) => topics.has(topic));
};

/** "ventas, caja e inventario" — con la "y" que toca. */
export const joinTopics = (topics: readonly string[]): string => {
  if (topics.length === 0) {
    return '';
  }
  if (topics.length === 1) {
    return topics[0];
  }
  const rest = topics.slice(0, -1).join(', ');
  const last = topics[topics.length - 1];
  // "e inventario" cuando la palabra siguiente empieza por i.
  const conjunction = /^i/i.test(last) ? 'e' : 'y';
  return `${rest} ${conjunction} ${last}`;
};

export interface GreetingContext {
  businessName: string;
  topics: readonly string[];
}

/** El saludo de toda la vida. Es el que se usa si la IA falla o está apagada. */
export const buildFallbackGreeting = ({ businessName, topics }: GreetingContext): string => {
  const areas = joinTopics(topics);
  const knows = areas.length > 0 ? ` Conozco sus ${areas}.` : '';
  return `Soy ${ASSISTANT_NAME}, el asistente de ${businessName}.${knows} Pregúntame lo que necesites.`;
};

/**
 * Instrucción para el modelo. Se le pide UNA frase, con el nombre del negocio
 * literal y las áreas que este usuario sí puede consultar.
 */
export const buildGreetingPrompt = ({ businessName, topics }: GreetingContext): string => {
  const areas = joinTopics(topics);

  return [
    `Escribe el saludo de bienvenida que ${ASSISTANT_NAME} le muestra a quien abre el chat.`,
    '',
    'REGLAS (obligatorias)',
    `1. Preséntate como ${ASSISTANT_NAME}, el asistente del negocio.`,
    `2. Menciona el nombre del negocio EXACTAMENTE así, sin cambiarlo ni traducirlo: ${businessName}`,
    areas.length > 0
      ? `3. Di que conoces sus datos de ${areas}. No prometas nada fuera de esa lista.`
      : '3. No prometas consultar datos concretos: este usuario no tiene informes habilitados.',
    '4. Cierra invitando a preguntar.',
    '5. Una sola frase corta (máximo 30 palabras). Texto plano: sin markdown, sin comillas, sin emojis, sin saltos de línea.',
    '6. Trata al usuario de "tú". No lo saludes por su nombre ni digas "hola": eso ya está escrito arriba del texto.',
    '7. Varía la redacción cada vez, pero nunca inventes datos, cifras ni funciones.',
    '8. Español de Colombia impecable: con tildes y bien puntuado.',
    '',
    'Responde ÚNICAMENTE con la frase.',
  ].join('\n');
};

/**
 * Limpia y valida lo que devolvió el modelo. `null` = no sirve, usa el fijo.
 *
 * La condición innegociable: el saludo TIENE que nombrar al negocio. Si el
 * modelo se lo saltó o se lo inventó, no se muestra.
 */
export const sanitizeGreeting = (raw: string | null | undefined, businessName: string): string | null => {
  const flat = (raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    // Markdown que el modelo cuela aunque se le pida texto plano.
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Comillas envolventes.
    .replace(/^["“'«]+/, '')
    .replace(/["”'»]+$/, '')
    .trim();

  if (flat.length < MIN_GREETING_LENGTH || flat.length > MAX_GREETING_LENGTH) {
    return null;
  }

  const business = businessName.trim();
  if (business.length > 0 && !flat.toLowerCase().includes(business.toLowerCase())) {
    return null;
  }

  return flat;
};
