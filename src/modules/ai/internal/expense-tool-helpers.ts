import { createHash } from 'node:crypto';

import Big from 'big.js';

import type { ExpenseSourceType } from '@/modules/expenses/entities/expense.entity';

import type { ChatTurn } from './gemini.types';

/**
 * Reglas puras de las herramientas de ESCRITURA de gastos de Place.
 *
 * Todo lo que decide "qué se ejecuta" vive aquí, sin BD, para poder probarlo
 * caso por caso: un monto mal leído o un "sí" mal interpretado mueve dinero
 * real. La regla general es fail-closed: ante la duda, NO se ejecuta y Place
 * le pregunta al usuario.
 */

/** Tope de `expenses.amount` (`numeric(15,2)`). */
export const MAX_EXPENSE_AMOUNT = new Big('9999999999999.99');

/** Mismo tope del DTO de `POST /expenses`. */
export const MAX_EXPENSE_DESCRIPTION_LENGTH = 500;

/** Minutos que vive una operación preparada esperando el "sí". */
export const PENDING_ACTION_TTL_MINUTES = 15;

/** Normaliza para comparar: minúsculas, sin tildes, sin signos, un espacio. */
export const normalizeText = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// ──────────────────────────────────────────────────────────────────────────
// Monto
// ──────────────────────────────────────────────────────────────────────────

export type MoneyReadResult =
  | { status: 'ok'; amount: Big }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

/**
 * Lee el valor del gasto que manda el modelo. NUNCA adivina:
 *
 *   - número JSON finito, > 0, con máximo 2 decimales → válido;
 *   - string solo con dígitos (opcionalmente `$` y hasta 2 decimales con
 *     punto) → válido;
 *   - "50.000", "50,000", "50 mil", "1.500,50"… → INVÁLIDO. En Colombia el
 *     punto es separador de miles: `parseFloat("50.000")` daría 50 pesos en vez
 *     de cincuenta mil. Mejor rechazar y que el modelo mande el número limpio.
 *   - más de 2 decimales → inválido (no se redondea en silencio).
 */
export const readMoneyArg = (args: Record<string, unknown>, key: string): MoneyReadResult => {
  const raw = args?.[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { status: 'missing' };
  }

  let amount: Big;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return { status: 'invalid', reason: 'El valor no es un número válido.' };
    }
    amount = new Big(raw);
  } else if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/^\$\s*/, '');
    if (!/^\d{1,13}(\.\d{1,2})?$/.test(cleaned)) {
      return {
        status: 'invalid',
        reason:
          'El valor debe ser un número sin separadores de miles (ej. 50000). Confirma con el usuario la cifra exacta.',
      };
    }
    amount = new Big(cleaned);
  } else {
    return { status: 'invalid', reason: 'El valor no es un número válido.' };
  }

  if (amount.lte(0)) {
    return { status: 'invalid', reason: 'El valor del gasto debe ser mayor a cero.' };
  }
  if (!amount.round(2).eq(amount)) {
    return { status: 'invalid', reason: 'El valor admite máximo 2 decimales.' };
  }
  if (amount.gt(MAX_EXPENSE_AMOUNT)) {
    return { status: 'invalid', reason: 'El valor supera el máximo permitido.' };
  }
  return { status: 'ok', amount };
};

// ──────────────────────────────────────────────────────────────────────────
// Concepto
// ──────────────────────────────────────────────────────────────────────────

/**
 * Conceptos que no dicen nada: el modelo los usa de relleno cuando el usuario
 * no dio el concepto. Registrar "Gasto" es registrar un gasto en blanco.
 */
const PLACEHOLDER_DESCRIPTIONS = new Set([
  '',
  'x',
  'xx',
  'xxx',
  'na',
  'n a',
  'ninguno',
  'sin concepto',
  'sin descripcion',
  'concepto',
  'descripcion',
  'gasto',
  'gastos',
  'un gasto',
  'gasto variable',
  'gasto general',
  'gastos varios',
  'varios',
  'otro',
  'otros',
  'pendiente',
  'por definir',
  'desconocido',
  'no especificado',
  'test',
  'prueba',
]);

export type DescriptionReadResult =
  | { status: 'ok'; description: string }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

export const readDescriptionArg = (
  args: Record<string, unknown>,
  key: string,
): DescriptionReadResult => {
  const raw = args?.[key];
  if (typeof raw !== 'string') {
    return { status: 'missing' };
  }
  const description = raw.trim().replace(/\s+/g, ' ');
  if (PLACEHOLDER_DESCRIPTIONS.has(normalizeText(description))) {
    return { status: 'missing' };
  }
  if (description.length > MAX_EXPENSE_DESCRIPTION_LENGTH) {
    return {
      status: 'invalid',
      reason: `El concepto admite máximo ${MAX_EXPENSE_DESCRIPTION_LENGTH} caracteres.`,
    };
  }
  return { status: 'ok', description };
};

// ──────────────────────────────────────────────────────────────────────────
// Fuente del dinero
// ──────────────────────────────────────────────────────────────────────────

/** Una cuenta de la que puede salir el gasto. */
export interface ExpenseSourceOption {
  source_type: ExpenseSourceType;
  source_id: number;
  /** Nombre legible: "Caja", "Bancolombia - 1234", "Nequi". */
  label: string;
  /** Nombre de la cuenta sin número (para hacer match). */
  name: string;
  account_number: string | null;
  balance: Big;
}

/** Formas en que el usuario dice "de la caja". */
const CASH_ALIASES = new Set([
  'caja',
  'mi caja',
  'la caja',
  'caja registradora',
  'efectivo',
  'en efectivo',
  'cash',
  'cash register',
]);

/** Muletillas al inicio: "desde la caja", "del banco Bancolombia"… */
const LEADING_FILLERS = new Set(['de', 'del', 'desde', 'la', 'el', 'mi', 'con', 'por', 'en']);

const stripLeadingFillers = (normalized: string): string => {
  const words = normalized.split(' ');
  while (words.length > 1 && LEADING_FILLERS.has(words[0])) {
    words.shift();
  }
  return words.join(' ');
};

const labelsOf = (option: ExpenseSourceOption): string[] => {
  if (option.source_type === 'cash_register') {
    return [...CASH_ALIASES];
  }
  const name = normalizeText(option.name);
  const labels = [name, normalizeText(option.label)];
  if (option.account_number) {
    labels.push(normalizeText(option.account_number));
  }
  return labels.filter((label) => label.length > 0);
};

export type SourceResolution =
  | { status: 'ok'; source: ExpenseSourceOption }
  | { status: 'not_found' }
  | { status: 'ambiguous'; matches: ExpenseSourceOption[] };

/**
 * Traduce lo que dijo el usuario ("caja", "Bancolombia", "nequi") a UNA cuenta.
 *
 *   1. Coincidencia EXACTA (sin tildes ni mayúsculas) con un único candidato →
 *      esa cuenta. Si dos cuentas coinciden exacto (dos bancos con el mismo
 *      nombre) → ambiguo: hay que preguntar cuál.
 *   2. Si no hay exacta, coincidencia parcial (el texto contiene el nombre o el
 *      nombre contiene el texto, mínimo 3 letras) con un único candidato.
 *   3. Cualquier otra cosa → no encontrada / ambigua. Place pregunta.
 */
export const resolveExpenseSource = (
  query: string,
  options: readonly ExpenseSourceOption[],
): SourceResolution => {
  const normalized = stripLeadingFillers(normalizeText(query));
  if (normalized.length === 0) {
    return { status: 'not_found' };
  }

  const exact = options.filter((option) => labelsOf(option).includes(normalized));
  if (exact.length === 1) {
    return { status: 'ok', source: exact[0] };
  }
  if (exact.length > 1) {
    return { status: 'ambiguous', matches: exact };
  }

  if (normalized.length < 3) {
    return { status: 'not_found' };
  }
  const partial = options.filter((option) =>
    labelsOf(option).some(
      (label) => label.length >= 3 && (label.includes(normalized) || normalized.includes(label)),
    ),
  );
  if (partial.length === 1) {
    return { status: 'ok', source: partial[0] };
  }
  if (partial.length > 1) {
    return { status: 'ambiguous', matches: partial };
  }
  return { status: 'not_found' };
};

// ──────────────────────────────────────────────────────────────────────────
// Confirmación explícita
// ──────────────────────────────────────────────────────────────────────────

/** Palabras que, por sí solas, significan "sí, hazlo". */
const AFFIRMATIVE_WORDS = new Set([
  'si',
  'sii',
  'siii',
  'sip',
  'simon',
  'confirmo',
  'confirmado',
  'confirma',
  'confirmar',
  'confirmalo',
  'dale',
  'ok',
  'okay',
  'okey',
  'oki',
  'listo',
  'hazlo',
  'hagalo',
  'hagale',
  'procede',
  'proceda',
  'adelante',
  'correcto',
  'perfecto',
  'exacto',
  'claro',
  'vale',
  'bien',
  'acuerdo',
  'afirmativo',
  'yes',
  'registralo',
  'registrelo',
  'registra',
  'archivalo',
  'archivelo',
  'archiva',
  'eliminalo',
  'eliminelo',
  'borralo',
  'borrelo',
  'anulalo',
  'una',
]);

/** Relleno permitido junto a una afirmación ("sí, por favor", "de acuerdo"). */
const FILLER_WORDS = new Set([
  'de',
  'por',
  'favor',
  'porfa',
  'porfavor',
  'place',
  'esta',
  'es',
  'asi',
  'todo',
  'eso',
  'gracias',
  'y',
  'lo',
  'el',
  'gasto',
  'seguro',
  'va',
  'ya',
  'muy',
  'pues',
  'senor',
  'senora',
  'hermano',
  'mano',
]);

const MAX_CONFIRMATION_WORDS = 8;

/**
 * ¿El mensaje es un "sí" explícito y NADA más?
 *
 * Todas las palabras deben pertenecer al vocabulario de confirmación y al
 * menos una debe ser afirmativa. Por eso "sí, pero de 60 mil", "no", "sí pero
 * desde Nequi" o "¿de qué caja sale?" NO confirman: cualquier palabra fuera
 * del vocabulario (un número, un "pero", un nombre) obliga a re-preparar la
 * operación con los datos nuevos y a mostrar un resumen nuevo.
 */
export const isExplicitConfirmation = (message: string | null | undefined): boolean => {
  if (typeof message !== 'string') {
    return false;
  }
  const normalized = normalizeText(message);
  if (normalized.length === 0) {
    return false;
  }
  const words = normalized.split(' ');
  if (words.length > MAX_CONFIRMATION_WORDS) {
    return false;
  }
  const allKnown = words.every((word) => AFFIRMATIVE_WORDS.has(word) || FILLER_WORDS.has(word));
  return allKnown && words.some((word) => AFFIRMATIVE_WORDS.has(word));
};

/** Huella de un mensaje del usuario (se compara entre peticiones). */
export const hashMessage = (message: string): string =>
  createHash('sha256').update(message.trim().replace(/\s+/g, ' ')).digest('hex');

// ──────────────────────────────────────────────────────────────────────────
// Contexto de la petición de chat
// ──────────────────────────────────────────────────────────────────────────

/** Lo que las herramientas de escritura necesitan saber de la conversación. */
export interface AiToolRequestContext {
  /** Id único de esta petición de chat (uuid). */
  request_id: string;
  /** El mensaje que el usuario acaba de enviar (último turno). */
  current_user_message: string | null;
  /**
   * El mensaje del usuario INMEDIATAMENTE anterior, siempre que entre ambos
   * haya una respuesta de Place (el resumen que se está confirmando). `null`
   * si no existe esa secuencia exacta usuario → Place → usuario.
   */
  previous_user_message: string | null;
}

/**
 * Extrae del historial crudo (tal cual lo manda el cliente) el mensaje actual
 * y el anterior del usuario. Exige la secuencia exacta
 * `[…, usuario, Place, usuario]` al final: si el turno previo no es de Place
 * (p. ej. dos mensajes seguidos del usuario) no hay "anterior" válido.
 */
export const extractRequestContext = (
  turns: readonly ChatTurn[],
  request_id: string,
): AiToolRequestContext => {
  const all_turns: readonly ChatTurn[] = Array.isArray(turns) ? turns : [];
  const usable = all_turns.filter(
    (turn) =>
      (turn?.role === 'user' || turn?.role === 'assistant') &&
      typeof turn.content === 'string' &&
      turn.content.trim().length > 0,
  );
  const last = usable[usable.length - 1];
  const current_user_message = last?.role === 'user' ? last.content : null;

  const reply = usable[usable.length - 2];
  const previous = usable[usable.length - 3];
  const previous_user_message =
    current_user_message !== null && reply?.role === 'assistant' && previous?.role === 'user'
      ? previous.content
      : null;

  return { request_id, current_user_message, previous_user_message };
};
