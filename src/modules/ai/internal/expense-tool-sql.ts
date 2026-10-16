import { normalizeNameSql } from '@/modules/categories/internal/category-lookups';

import { accentInsensitiveLike } from './tool-sql';

/**
 * SQL de las herramientas de ESCRITURA de gastos de Place.
 *
 * Las lecturas (fuentes, búsqueda del gasto a archivar, operación pendiente)
 * son SQL plano de un solo viaje a la BD. Las escrituras del gasto NO están
 * aquí: se delegan a `CreateExpenseAction` / `VoidExpenseAction`, que son la
 * única fuente de verdad de cómo se debita una caja, se registra el movimiento
 * financiero o se crea la alerta de anulación.
 *
 * Toda query filtra por `company_id` (y las de la pendiente, además por
 * `user_id`): un usuario jamás ve ni confirma operaciones de otro.
 */

/** Cantidad máxima de gastos candidatos que se le muestran al usuario. */
export const VOID_CANDIDATES_LIMIT = 10;

/**
 * Las cuentas de las que puede salir un gasto, en un solo viaje:
 * la caja PROPIA del actor (misma regla que `POST /expenses`: un gasto de caja
 * sale de la caja de quien lo registra) + bancos y billeteras activos.
 *
 * $1 = company_id, $2 = user_id del actor.
 */
export const EXPENSE_SOURCES_SQL = `
  SELECT 'cash_register'::text AS source_type, cr.id, 'Caja'::text AS name,
         NULL::text AS account_number, cr.balance
    FROM cash_registers cr
   WHERE cr.company_id = $1 AND cr.user_id = $2
  UNION ALL
  SELECT 'bank', b.id, b.name, b.account_number, b.balance
    FROM banks b
   WHERE b.company_id = $1 AND b.is_archived = false
  UNION ALL
  SELECT 'wallet', w.id, w.name, NULL, w.balance
    FROM wallets w
   WHERE w.company_id = $1 AND w.is_archived = false
`;

/**
 * Reemplaza la pendiente anterior del usuario (si la hay) y crea la nueva en
 * UNA sentencia. El `FROM (SELECT count(*) FROM superseded)` obliga a que el
 * UPDATE termine antes del INSERT, así el índice único parcial
 * `uq_ai_pending_actions_one_pending` nunca ve dos PENDING a la vez.
 *
 * UNA operación por respuesta: si ESTA misma petición ya preparó una (el
 * modelo intentó preparar dos gastos a la vez), no se reemplaza ni se inserta
 * nada y no devuelve filas. Sin esto, el segundo resumen pisaría al primero y
 * el "sí" del usuario ejecutaría solo uno de los dos que vio.
 *
 * $1 company_id, $2 user_id, $3 action_type, $4 payload (jsonb),
 * $5 request_id, $6 trigger_message_hash, $7 minutos de vigencia.
 */
export const UPSERT_PENDING_ACTION_SQL = `
  WITH same_request AS (
    SELECT 1
      FROM ai_pending_actions
     WHERE company_id = $1 AND user_id = $2 AND status = 'PENDING' AND request_id = $5::uuid
  ),
  superseded AS (
    UPDATE ai_pending_actions
       SET status = 'SUPERSEDED'
     WHERE company_id = $1 AND user_id = $2 AND status = 'PENDING'
       AND NOT EXISTS (SELECT 1 FROM same_request)
    RETURNING id
  )
  INSERT INTO ai_pending_actions
    (company_id, user_id, action_type, payload, request_id, trigger_message_hash, expires_at)
  SELECT $1, $2, $3, $4::jsonb, $5::uuid, $6, now() + make_interval(mins => $7::int)
    FROM (SELECT count(*) FROM superseded) AS s
   WHERE NOT EXISTS (SELECT 1 FROM same_request)
  RETURNING id
`;

/**
 * La pendiente vigente del usuario, BLOQUEADA (`FOR UPDATE`) hasta el fin de
 * la transacción de confirmación: dos "sí" simultáneos se serializan y el
 * segundo ya la encuentra EXECUTED → no se ejecuta dos veces.
 *
 * $1 company_id, $2 user_id.
 */
export const LOCK_PENDING_ACTION_SQL = `
  SELECT id, action_type, payload, request_id::text AS request_id,
         trigger_message_hash, (expires_at <= now()) AS is_expired
    FROM ai_pending_actions
   WHERE company_id = $1 AND user_id = $2 AND status = 'PENDING'
   FOR UPDATE
`;

/** $1 id, $2 company_id, $3 result_ref. */
export const MARK_PENDING_EXECUTED_SQL = `
  UPDATE ai_pending_actions
     SET status = 'EXECUTED', executed_at = now(), result_ref = $3
   WHERE id = $1 AND company_id = $2 AND status = 'PENDING'
`;

/** $1 id, $2 company_id. */
export const MARK_PENDING_EXPIRED_SQL = `
  UPDATE ai_pending_actions
     SET status = 'EXPIRED'
   WHERE id = $1 AND company_id = $2 AND status = 'PENDING'
`;

/**
 * Re-lee y BLOQUEA el gasto a archivar justo antes de anularlo, para comparar
 * contra el snapshot que vio el usuario. $1 id, $2 company_id.
 */
export const LOCK_EXPENSE_FOR_VOID_SQL = `
  SELECT id, description, amount::text AS amount, is_archived, is_fixed
    FROM expenses
   WHERE id = $1 AND company_id = $2
   FOR UPDATE
`;

/** Columnas que se le muestran al usuario de un gasto candidato. */
const EXPENSE_CANDIDATE_COLUMNS = `
  e.id, e.description, e.amount::text AS amount, e.expense_date,
  e.source_type, e.source_name, e.created_by, e.is_archived, e.is_fixed`;

/** Un gasto por id, sin filtrar estado (para explicar por qué no se puede). */
export const FIND_EXPENSE_BY_ID_SQL = `
  SELECT ${EXPENSE_CANDIDATE_COLUMNS}
    FROM expenses e
   WHERE e.id = $1 AND e.company_id = $2
`;

export interface VoidSearchFilters {
  /** Texto del concepto tal cual lo dijo el usuario. */
  query: string;
  /** Valor exacto, como string decimal. */
  amount: string | null;
  /** Rango UTC del día colombiano pedido. */
  date_range: { start: Date; end: Date } | null;
}

/** Escapa los comodines de LIKE para que "%" o "_" del usuario sean literales. */
export const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

/**
 * Gastos VARIABLES activos cuyo concepto contiene el texto (sin tildes ni
 * mayúsculas), opcionalmente por valor exacto y día. Los gastos FIJOS
 * (`is_fixed = true`) se gestionan en su propio módulo: nunca se archivan
 * desde aquí. Primero las coincidencias exactas, luego las más recientes.
 *
 * `total_matches` (ventana) dice cuántos hay de verdad aunque la lista venga
 * recortada. Usa el índice parcial `idx_expenses_company_expense_date_active`.
 */
export const buildVoidSearchSql = (
  company_id: number,
  filters: VoidSearchFilters,
): { sql: string; params: unknown[] } => {
  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const company = push(String(company_id));
  const pattern = push(`%${escapeLikePattern(filters.query.toLowerCase())}%`);
  const exact = push(filters.query);
  const conditions = [
    `e.company_id = ${company}`,
    'e.is_archived = false',
    'e.is_fixed = false',
    accentInsensitiveLike('e.description', pattern),
  ];
  if (filters.amount !== null) {
    conditions.push(`e.amount = ${push(filters.amount)}::numeric`);
  }
  if (filters.date_range !== null) {
    conditions.push(
      `e.expense_date BETWEEN ${push(filters.date_range.start)} AND ${push(filters.date_range.end)}`,
    );
  }

  const sql = `
    SELECT ${EXPENSE_CANDIDATE_COLUMNS},
           count(*) OVER () AS total_matches
      FROM expenses e
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY (${normalizeNameSql('e.description')} = ${normalizeNameSql(exact)}) DESC,
              e.expense_date DESC, e.id DESC
     LIMIT ${VOID_CANDIDATES_LIMIT}
  `;
  return { sql, params };
};
