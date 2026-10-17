/**
 * SQL del consumo de Place para el panel superadmin. Rango en instantes UTC
 * (días de Colombia ya convertidos con `parseUtcRange`); `company_id` opcional
 * para ver un solo negocio. El "día" de la serie es el calendario de Colombia.
 */

/** Negocios que se listan en el ranking de consumo. */
export const AI_USAGE_TOP_COMPANIES = 50;

const scope = (with_company: boolean): string =>
  `e.created_at BETWEEN $1 AND $2${with_company ? ' AND e.company_id = $3' : ''}`;

const TOKEN_SUMS = `
  COALESCE(SUM(e.prompt_tokens), 0)::bigint   AS prompt_tokens,
  COALESCE(SUM(e.output_tokens), 0)::bigint   AS output_tokens,
  COALESCE(SUM(e.thoughts_tokens), 0)::bigint AS thoughts_tokens,
  COALESCE(SUM(e.cached_tokens), 0)::bigint   AS cached_tokens,
  COALESCE(SUM(e.total_tokens), 0)::bigint    AS total_tokens,
  COUNT(*) FILTER (WHERE e.kind = 'chat')::int     AS questions,
  COUNT(*) FILTER (WHERE e.kind = 'greeting')::int AS greetings`;

/** Totales del rango. $1 desde, $2 hasta [, $3 company]. */
export const buildAiUsageTotalsSql = (with_company: boolean): string => `
  SELECT ${TOKEN_SUMS}
    FROM ai_usage_events e
   WHERE ${scope(with_company)}
`;

/** Serie por día de Colombia. $1 desde, $2 hasta [, $3 company]. */
export const buildAiUsageDailySql = (with_company: boolean): string => `
  SELECT to_char((e.created_at AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD') AS day,
         ${TOKEN_SUMS}
    FROM ai_usage_events e
   WHERE ${scope(with_company)}
   GROUP BY 1
   ORDER BY 1
`;

/** Consumo por modelo. $1 desde, $2 hasta [, $3 company]. */
export const buildAiUsageByModelSql = (with_company: boolean): string => `
  SELECT e.model, ${TOKEN_SUMS}
    FROM ai_usage_events e
   WHERE ${scope(with_company)}
   GROUP BY e.model
   ORDER BY total_tokens DESC
`;

/**
 * Ranking de negocios por tokens, con sus créditos del día. $1 desde, $2
 * hasta, $3 día de hoy (Colombia).
 */
export const AI_USAGE_BY_COMPANY_SQL = `
  SELECT c.id AS company_id, c.name AS company_name, c.ai_enabled,
         c.ai_daily_credits, COALESCE(u.messages, 0)::int AS used_today,
         ${TOKEN_SUMS}
    FROM ai_usage_events e
    JOIN companies c ON c.id = e.company_id
    LEFT JOIN ai_daily_credit_usage u ON u.company_id = c.id AND u.day = $3::date
   WHERE e.created_at BETWEEN $1 AND $2
   GROUP BY c.id, c.name, c.ai_enabled, c.ai_daily_credits, u.messages
   ORDER BY total_tokens DESC, c.id
   LIMIT ${AI_USAGE_TOP_COMPANIES}
`;

/** Negocios con Place encendido (para el resumen del dashboard). */
export const AI_ENABLED_COMPANIES_SQL = `
  SELECT COUNT(*) FILTER (WHERE ai_enabled)::int AS enabled,
         COUNT(*) FILTER (WHERE ai_enabled AND ai_daily_credits = 0)::int AS enabled_without_credits
    FROM companies
`;
