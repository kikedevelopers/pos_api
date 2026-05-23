import type { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

/**
 * Ejecuta una transacción en aislamiento SERIALIZABLE con reintento
 * automático sobre `serialization_failure` (SQLSTATE 40001).
 *
 * Por qué reintentar:
 *   PostgreSQL permite que una transacción `SERIALIZABLE` aborte aunque el
 *   código sea correcto: la base detecta una "anomalía serializable" (lectura
 *   no repetible, write-skew, etc.) y obliga a reintentar. El driver
 *   `pg` propaga ese error con `code = '40001'`. El cliente DEBE reintentar
 *   con la misma lógica — no hay alternativa.
 *
 * Política:
 *   - Hasta `maxRetries` reintentos (default 2). Para un total de 3
 *     ejecuciones máximo.
 *   - Backoff lineal opcional (default 0ms — la mayoría de aplicaciones POS
 *     prefieren reintentar al instante).
 *   - Si el último intento falla, se propaga el error tal cual.
 *
 * Uso:
 *
 *   await runSerializableWithRetry(this.dataSource, async (manager) => {
 *     // ... operaciones críticas ...
 *   });
 */
export async function runSerializableWithRetry<T>(
  dataSource: DataSource,
  callback: (manager: EntityManager) => Promise<T>,
  options: { maxRetries?: number; backoffMs?: number; logger?: Logger } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const backoffMs = options.backoffMs ?? 0;
  const logger = options.logger;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await dataSource.transaction('SERIALIZABLE', callback);
    } catch (error) {
      const code = extractPgCode(error);
      if (code === '40001' && attempt < maxRetries) {
        attempt += 1;
        logger?.warn({
          event: 'serializable_retry',
          attempt,
          maxRetries,
          code,
        });
        if (backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
        }
        continue;
      }
      throw error;
    }
  }
}

/**
 * Extrae el `code` SQLSTATE del error si proviene del driver `pg`.
 *
 * Los errores envueltos por TypeORM mantienen la propiedad `.code` o exponen
 * el `driverError` original. Inspeccionamos ambos caminos para no perder el
 * `40001`.
 */
function extractPgCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const e = error as { code?: unknown; driverError?: { code?: unknown } };
  if (typeof e.code === 'string') {
    return e.code;
  }
  if (e.driverError && typeof e.driverError.code === 'string') {
    return e.driverError.code;
  }
  return null;
}
