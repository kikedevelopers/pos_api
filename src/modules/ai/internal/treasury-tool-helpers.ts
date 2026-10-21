import type Big from 'big.js';

import { normalizeText } from './expense-tool-helpers';

/**
 * Reglas puras de las herramientas de TESORERÍA de Place: mover saldo entre
 * cajas, bancos y billeteras, y corregir el saldo de una cuenta.
 *
 * Todo lo que decide "de qué cuenta a qué cuenta" vive aquí, sin BD, para
 * probarlo caso por caso. Regla general fail-closed: si el texto del usuario
 * no señala UNA cuenta sin lugar a dudas, no se prepara nada y Place pregunta.
 */

export type TreasuryAccountKind = 'cash_register' | 'bank' | 'wallet';

/** Una cuenta de la company: caja de un usuario, banco o billetera activos. */
export interface TreasuryAccount {
  kind: TreasuryAccountKind;
  /** Id de la fila (`cash_registers.id`, `banks.id`, `wallets.id`). 0 = caja propia aún sin crear. */
  id: number;
  /** Dueño de la caja (solo `cash_register`). */
  user_id: number | null;
  /** Nombre de la cuenta, o el nombre completo del dueño de la caja. */
  name: string;
  account_number: string | null;
  balance: Big;
  /** La caja del usuario que conversa con Place. */
  is_own: boolean;
}

export const KIND_LABEL: Record<TreasuryAccountKind, string> = {
  cash_register: 'caja',
  bank: 'banco',
  wallet: 'billetera',
};

/** Nombre legible y estable: "Mi caja", "Caja de Ana Gómez", "Bancolombia - 123", "Nequi". */
export const accountLabel = (account: TreasuryAccount): string => {
  if (account.kind === 'cash_register') {
    return account.is_own ? 'Mi caja' : `Caja de ${account.name}`;
  }
  return account.kind === 'bank' && account.account_number
    ? `${account.name} - ${account.account_number}`
    : account.name;
};

// ──────────────────────────────────────────────────────────────────────────
// Resolución de la cuenta que nombró el usuario
// ──────────────────────────────────────────────────────────────────────────

/** Palabra inicial que fija el TIPO de cuenta ("banco Nequi", "billetera Efectivo"). */
const KIND_WORDS: Record<string, TreasuryAccountKind> = {
  caja: 'cash_register',
  banco: 'bank',
  cuenta: 'bank',
  billetera: 'wallet',
  wallet: 'wallet',
};

/** Muletillas que no nombran la cuenta: "desde la caja de Ana", "al banco". */
const FILLERS = new Set([
  'de',
  'del',
  'desde',
  'la',
  'el',
  'los',
  'las',
  'a',
  'al',
  'hacia',
  'para',
  'en',
  'con',
  'por',
  'mi',
]);

/** Lo que queda de "caja …" cuando se refiere a la caja PROPIA. */
const OWN_CASH_REST = new Set(['', 'mia', 'propia', 'principal', 'registradora']);

/**
 * Formas de decir "la caja" sin la palabra caja. Solo valen si NINGUNA cuenta
 * se llama así: con una billetera "Efectivo", "efectivo" es esa billetera.
 */
const OWN_CASH_ALIASES = new Set(['efectivo', 'cash']);

const stripFillers = (words: string[]): string[] => {
  const out = [...words];
  while (out.length > 0 && FILLERS.has(out[0])) {
    out.shift();
  }
  return out;
};

/** Textos con los que el usuario puede nombrar una cuenta (normalizados). */
const namesOf = (account: TreasuryAccount): string[] => {
  const names = [normalizeText(account.name), normalizeText(accountLabel(account))];
  if (account.kind === 'cash_register') {
    names.push(`caja ${normalizeText(account.name)}`);
  } else if (account.account_number) {
    names.push(normalizeText(account.account_number));
  }
  return names.filter((name) => name.length > 0);
};

export type AccountResolution =
  | { status: 'ok'; account: TreasuryAccount }
  | { status: 'not_found' }
  | { status: 'ambiguous'; matches: TreasuryAccount[] };

const pick = (matches: TreasuryAccount[]): AccountResolution | null => {
  if (matches.length === 1) {
    return { status: 'ok', account: matches[0] };
  }
  return matches.length > 1 ? { status: 'ambiguous', matches } : null;
};

/**
 * Traduce lo que dijo el usuario ("Nequi", "banco Nequi", "la caja de Ana",
 * "mi caja", "efectivo") a UNA cuenta. En orden:
 *
 *   1. Coincidencia EXACTA con el nombre completo de una cuenta.
 *   2. Si empieza por un tipo ("banco", "billetera", "caja"), solo se busca
 *      entre las de ese tipo. "caja" a secas / "mi caja" = la caja propia.
 *   3. Exacta con el resto del texto dentro del tipo.
 *   4. "efectivo"/"cash" = la caja propia, si ninguna otra cuenta lo lleva
 *      en su nombre (si alguna lo lleva → ambigua).
 *   5. Parcial (mínimo 3 letras): el nombre de la cuenta CONTIENE el texto,
 *      con un único candidato. Nunca al revés: "caja de Juan Carlos" no es la
 *      caja de "Juan".
 *
 * Dos o más coincidencias en un mismo paso → ambigua (se pregunta).
 */
export const resolveTreasuryAccount = (
  query: string,
  accounts: readonly TreasuryAccount[],
): AccountResolution => {
  const words = stripFillers(normalizeText(query).split(' ').filter(Boolean));
  if (words.length === 0) {
    return { status: 'not_found' };
  }
  const full = words.join(' ');

  const exact = pick(accounts.filter((account) => namesOf(account).includes(full)));
  if (exact) {
    return exact;
  }

  const kind = KIND_WORDS[words[0]] ?? null;
  const rest = kind ? stripFillers(words.slice(1)).join(' ') : full;
  const pool = kind ? accounts.filter((account) => account.kind === kind) : accounts;

  if (kind === 'cash_register' && OWN_CASH_REST.has(rest)) {
    return pick(pool.filter((account) => account.is_own)) ?? { status: 'not_found' };
  }
  if (!kind && OWN_CASH_ALIASES.has(rest)) {
    const own = accounts.find((account) => account.kind === 'cash_register' && account.is_own);
    // Una cuenta cuyo nombre lo contiene ("Efectivo tienda") también podría
    // ser: se pregunta en vez de asumir la caja.
    const named = accounts.filter(
      (account) => account !== own && namesOf(account).some((name) => name.includes(rest)),
    );
    if (own && named.length === 0) {
      return { status: 'ok', account: own };
    }
    if (own) {
      return { status: 'ambiguous', matches: [own, ...named] };
    }
  }
  if (rest.length === 0) {
    return { status: 'not_found' };
  }

  const exact_in_kind = pick(pool.filter((account) => namesOf(account).includes(rest)));
  if (exact_in_kind) {
    return exact_in_kind;
  }

  if (rest.length < 3) {
    return { status: 'not_found' };
  }
  return (
    pick(pool.filter((account) => namesOf(account).some((name) => name.includes(rest)))) ?? {
      status: 'not_found',
    }
  );
};

// ──────────────────────────────────────────────────────────────────────────
// Rutas de un traslado
// ──────────────────────────────────────────────────────────────────────────

/**
 * Cómo se ejecuta un traslado, siempre con la acción canónica de la app:
 *   - `accounts`: banco/billetera → banco/billetera, o billetera → caja de
 *     OTRO usuario (`POST /accounts/transfer`, `TransferAction`).
 *   - `cash`: caja (de cualquier usuario de la company) → banco/billetera
 *     (`TransferCashAction`, la de "Mover saldo" del POS).
 */
export type TransferRoute =
  | {
      status: 'ok';
      via: 'accounts';
      source_type: 'bank' | 'wallet';
      destination_type: 'bank' | 'wallet' | 'user';
      /** Para destino caja: el `user_id` dueño de la caja. */
      destination_id: number;
    }
  | { status: 'ok'; via: 'cash'; register_user_id: number; destination_type: 'bank' | 'wallet' }
  | { status: 'unsupported'; reason: string };

/**
 * Decide la ruta de un traslado. Las combinaciones que la app no permite
 * (las mismas reglas de `TransferAction`) se rechazan con la alternativa:
 *   - misma cuenta;
 *   - banco → caja (la app solo abastece cajas desde una billetera);
 *   - billetera → caja PROPIA (el dinero no cambia de manos);
 *   - caja → caja.
 */
export const classifyTransferRoute = (
  from: TreasuryAccount,
  to: TreasuryAccount,
): TransferRoute => {
  if (from.kind === to.kind && from.id === to.id && from.user_id === to.user_id) {
    return { status: 'unsupported', reason: 'El origen y el destino son la misma cuenta.' };
  }

  if (from.kind === 'cash_register') {
    if (to.kind === 'cash_register') {
      return {
        status: 'unsupported',
        reason:
          'No se mueve saldo de una caja a otra directamente: pásalo primero a una billetera y de ahí a la otra caja.',
      };
    }
    if (from.user_id === null || from.id === 0) {
      return { status: 'unsupported', reason: 'Esa caja aún no tiene saldo.' };
    }
    return { status: 'ok', via: 'cash', register_user_id: from.user_id, destination_type: to.kind };
  }

  if (to.kind === 'cash_register') {
    if (from.kind === 'bank') {
      return {
        status: 'unsupported',
        reason:
          'Una caja solo se abastece desde una billetera: mueve primero del banco a una billetera y de ahí a la caja.',
      };
    }
    if (to.is_own || to.user_id === null) {
      return {
        status: 'unsupported',
        reason: 'No se traslada saldo a tu propia caja desde una billetera.',
      };
    }
    return {
      status: 'ok',
      via: 'accounts',
      source_type: from.kind,
      destination_type: 'user',
      destination_id: to.user_id,
    };
  }

  return {
    status: 'ok',
    via: 'accounts',
    source_type: from.kind,
    destination_type: to.kind,
    destination_id: to.id,
  };
};

// ──────────────────────────────────────────────────────────────────────────
// Motivo de una corrección
// ──────────────────────────────────────────────────────────────────────────

/** Tope del motivo (el DTO de banco/billetera admite 280 con su prefijo). */
export const MAX_ADJUSTMENT_REASON_LENGTH = 200;

/** Marca de auditoría: la corrección se hizo conversando con Place. */
export const PLACE_ADJUSTMENT_NOTE = 'con Place';

/**
 * Motivo que queda en el movimiento: el del usuario (recortado) + la marca de
 * Place, o solo la marca. `null` = el motivo es demasiado largo.
 */
export const buildAdjustmentReason = (raw: unknown): string | null => {
  const reason = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (reason.length > MAX_ADJUSTMENT_REASON_LENGTH) {
    return null;
  }
  return reason.length > 0
    ? `${reason} (${PLACE_ADJUSTMENT_NOTE})`
    : `Corrección ${PLACE_ADJUSTMENT_NOTE}`;
};
