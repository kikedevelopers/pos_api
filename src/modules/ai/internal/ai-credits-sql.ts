/**
 * SQL de los créditos diarios de Place. Todo por `company_id`: un negocio
 * jamás gasta ni ve los créditos de otro.
 */

/** Tope de créditos diarios asignables desde el panel. */
export const MAX_DAILY_CREDITS = 100_000;

/**
 * Reserva UN crédito del día en una sola sentencia (atómica):
 *   - sin fila del día → la crea con 1, si el límite es > 0;
 *   - con fila → suma 1 SOLO si todavía está por debajo del límite.
 * El `ON CONFLICT DO UPDATE` bloquea la fila: dos mensajes simultáneos se
 * serializan y nunca pasan el límite. Sin filas devueltas = sin créditos.
 *
 * $1 company_id, $2 día (YYYY-MM-DD, Colombia). Devuelve `messages` y `daily_limit`.
 */
export const RESERVE_DAILY_CREDIT_SQL = `
  WITH company AS (
    SELECT c.ai_daily_credits AS daily_limit FROM companies c WHERE c.id = $1
  )
  INSERT INTO ai_daily_credit_usage AS u (company_id, day, messages)
  SELECT $1, $2::date, 1 FROM company WHERE company.daily_limit > 0
  ON CONFLICT (company_id, day) DO UPDATE
     SET messages = u.messages + 1
   WHERE u.messages < (SELECT daily_limit FROM company)
  RETURNING u.messages, (SELECT daily_limit FROM company) AS daily_limit
`;

/** Devuelve un crédito reservado (la respuesta falló por nuestra culpa). $1 company, $2 día. */
export const REFUND_DAILY_CREDIT_SQL = `
  UPDATE ai_daily_credit_usage
     SET messages = messages - 1
   WHERE company_id = $1 AND day = $2::date AND messages > 0
`;

/** Límite y uso del día de una company. $1 company, $2 día. */
export const DAILY_CREDITS_STATUS_SQL = `
  SELECT c.ai_daily_credits AS daily_limit,
         COALESCE(u.messages, 0) AS used_today
    FROM companies c
    LEFT JOIN ai_daily_credit_usage u ON u.company_id = c.id AND u.day = $2::date
   WHERE c.id = $1
`;

/** Fija el límite diario. $1 company, $2 créditos. */
export const SET_DAILY_CREDITS_SQL = `
  UPDATE companies SET ai_daily_credits = $2 WHERE id = $1
  RETURNING ai_daily_credits
`;

/** Registra el consumo de una llamada a Gemini. */
export const INSERT_USAGE_EVENT_SQL = `
  INSERT INTO ai_usage_events
    (company_id, user_id, kind, model, prompt_tokens, output_tokens,
     thoughts_tokens, cached_tokens, total_tokens, rounds)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
`;
