import type { EntityManager } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';

/**
 * Configuración de TURNOS de pedido (solo modo restaurante).
 *
 * Persistida como 3 keys en `app_settings` (per-company), misma mecánica
 * clave-valor que el resto de settings:
 *   - `turnos_enabled`  (`'true'` | `'false'`). Default `false`.
 *   - `turnos_max`      tope del ciclo, entero en [1, 99]. Default 99.
 *   - `turnos_counter`  último turno asignado (0 = ninguno aún). Default 0.
 *
 * El turno se comporta como un consecutivo CÍCLICO: al crear un pedido (ORDER)
 * se incrementa el contador; cuando supera `turnos_max` reinicia en 1. El
 * incremento es ATÓMICO (un solo `UPDATE ... RETURNING` con lock de fila) para
 * que dos pedidos concurrentes nunca reciban el mismo turno — igual criterio
 * que `IncrementTicketNumberAction` con los folios.
 */
export interface TurnosConfig {
  enabled: boolean;
  /** Tope del ciclo (1..99). */
  max: number;
  /** Último turno asignado (0 = ninguno aún). Solo lectura para la UI. */
  counter: number;
}

export const TURNOS_MIN_MAX = 1;
export const TURNOS_MAX_MAX = 99;
export const TURNOS_DEFAULT_MAX = 99;

/** Normaliza el tope a un entero dentro de [1, 99]; fuera de rango → default. */
export const clampTurnosMax = (value: number): number => {
  if (!Number.isFinite(value)) return TURNOS_DEFAULT_MAX;
  const int = Math.trunc(value);
  if (int < TURNOS_MIN_MAX) return TURNOS_MIN_MAX;
  if (int > TURNOS_MAX_MAX) return TURNOS_MAX_MAX;
  return int;
};

const parseIntOr = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
};

/**
 * Lee la config de turnos de la company. Si alguna key falta usa el default
 * (`enabled=false`, `max=99`, `counter=0`). Recibe el `EntityManager` del caller.
 */
export const getTurnosConfig = async (
  manager: EntityManager,
  companyId: number,
): Promise<TurnosConfig> => {
  const repo = manager.getRepository(AppSetting);
  const company_id = String(companyId);
  // Lecturas SECUENCIALES a propósito: este helper también corre dentro de
  // transacciones (upsert/reset), y una transacción tiene UNA sola conexión.
  // Un `Promise.all` dispararía "client is already executing a query" y podría
  // corromper resultados. El costo de 3 reads seriales de settings es trivial.
  const enabledRow = await repo.findOne({
    where: { company_id, key: APP_SETTING_KEYS.TURNOS_ENABLED },
  });
  const maxRow = await repo.findOne({
    where: { company_id, key: APP_SETTING_KEYS.TURNOS_MAX },
  });
  const counterRow = await repo.findOne({
    where: { company_id, key: APP_SETTING_KEYS.TURNOS_COUNTER },
  });
  return {
    enabled: enabledRow?.value === 'true',
    max: clampTurnosMax(parseIntOr(maxRow?.value, TURNOS_DEFAULT_MAX)),
    counter: Math.max(0, parseIntOr(counterRow?.value, 0)),
  };
};

/**
 * Upsert de `turnos_enabled` + `turnos_max` (NO toca el contador). El contador
 * se mueve solo al asignar turnos. Upsert por `(company_id, key)`.
 */
export const setTurnosConfig = async (
  manager: EntityManager,
  companyId: number,
  cfg: { enabled: boolean; max: number },
): Promise<void> => {
  const repo = manager.getRepository(AppSetting);
  const company_id = String(companyId);
  await repo.upsert(
    [
      {
        company_id,
        key: APP_SETTING_KEYS.TURNOS_ENABLED,
        value: cfg.enabled ? 'true' : 'false',
      },
      {
        company_id,
        key: APP_SETTING_KEYS.TURNOS_MAX,
        value: String(clampTurnosMax(cfg.max)),
      },
    ],
    ['company_id', 'key'],
  );
};

/** Reinicia el contador a 0 (el próximo turno asignado será 1). */
export const resetTurnosCounter = async (
  manager: EntityManager,
  companyId: number,
): Promise<void> => {
  const repo = manager.getRepository(AppSetting);
  await repo.upsert(
    [{ company_id: String(companyId), key: APP_SETTING_KEYS.TURNOS_COUNTER, value: '0' }],
    ['company_id', 'key'],
  );
};

/**
 * Asigna el PRÓXIMO turno para la company y devuelve su número, o `null` si los
 * turnos están deshabilitados. Participa de la transacción del caller (recibe
 * `EntityManager`): si la creación del pedido hace rollback, el turno NO se
 * quema.
 *
 * Atomicidad: garantiza que la fila del contador exista (`INSERT ON CONFLICT DO
 * NOTHING`), y luego un único `UPDATE ... RETURNING` con el ciclo calculado en
 * SQL. El UPDATE toma lock de fila → turnos disjuntos entre pedidos concurrentes.
 */
export const assignNextTurn = async (
  manager: EntityManager,
  companyId: number,
): Promise<number | null> => {
  const company_id = String(companyId);

  // IMPORTANTE: este action corre DENTRO de la transacción de creación del
  // pedido, que tiene UNA sola conexión. Por eso NO se usa `getTurnosConfig`
  // (hace `Promise.all` de 3 queries en paralelo → "client is already executing
  // a query" y resultados corruptos). Aquí todo es secuencial y una sentencia
  // por query.

  // 1. Lee enabled + max en UNA query. Si los turnos están apagados → null.
  const cfgRows = (await manager.query(
    `SELECT
        (SELECT value FROM app_settings WHERE company_id = $1 AND key = $2) AS enabled,
        (SELECT value FROM app_settings WHERE company_id = $1 AND key = $3) AS max`,
    [company_id, APP_SETTING_KEYS.TURNOS_ENABLED, APP_SETTING_KEYS.TURNOS_MAX],
  )) as Array<{ enabled: string | null; max: string | null }>;
  const cfg = cfgRows[0];
  if (!cfg || cfg.enabled !== 'true') return null;
  const max = clampTurnosMax(parseIntOr(cfg.max ?? undefined, TURNOS_DEFAULT_MAX));

  // 2. Garantiza la fila del contador (tenants viejos sin seed). Idempotente.
  await manager.query(
    `INSERT INTO app_settings (company_id, key, value, created_at, updated_at)
     VALUES ($1, $2, '0', now(), now())
     ON CONFLICT (company_id, key) DO NOTHING`,
    [company_id, APP_SETTING_KEYS.TURNOS_COUNTER],
  );

  // 3. Incremento cíclico atómico: al superar el tope, reinicia en 1. Se usa el
  //    QueryBuilder `.returning(['value']).execute()` (mismo patrón que
  //    IncrementTicketNumberAction) porque `manager.query('UPDATE … RETURNING')`
  //    devuelve una TUPLA `[rows, count]` en este driver, no el array de filas —
  //    leer `rows[0]` daría el array interno y el turno se perdería. `.raw` sí da
  //    las filas limpias. `max` es un entero validado (1..99): interpolarlo es
  //    seguro (sin inyección) y evita params dentro del `set`.
  const updateResult = await manager
    .createQueryBuilder()
    .update(AppSetting)
    .set({
      value: () =>
        `(CASE WHEN coalesce(value, '0')::int >= ${max} THEN 1 ELSE coalesce(value, '0')::int + 1 END)::text`,
      updated_at: () => 'now()',
    })
    .where('company_id = :cid AND key = :key', {
      cid: company_id,
      key: APP_SETTING_KEYS.TURNOS_COUNTER,
    })
    .returning(['value'])
    .execute();

  const raw = updateResult.raw as Array<{ value: string }>;
  // NUNCA devolver NaN: iría a una columna integer y reventaría el INSERT del
  // pedido. Ante cualquier anomalía, se omite el turno (null).
  const turn = Array.isArray(raw) && raw.length > 0 ? Number(raw[0].value) : NaN;
  return Number.isFinite(turn) ? turn : null;
};
