import type { Logger } from '@nestjs/common';

/**
 * Convierte un id `bigint` (string en TypeORM) a `number`. El contrato PlacePos
 * espera ids numéricos. Si el id excede `Number.MAX_SAFE_INTEGER` loguea un
 * warning; en práctica no rompe hasta tener ~9e15 filas.
 */
export function bigintToNumber(id: string, logger: Logger, what: string): number {
  const n = Number(id);
  if (!Number.isSafeInteger(n)) {
    logger.warn(
      `${what} id excede Number.MAX_SAFE_INTEGER (${id}); puede perder precisión en JSON`,
    );
  }
  return n;
}
