import { isValidDateString } from '@/modules/reports/internal/range';

/**
 * Lectura defensiva de los argumentos que produce el modelo.
 *
 * Un LLM puede mandar un número como string, una fecha inventada o un `limit`
 * absurdo. Estas funciones son puras, no lanzan por tipos raros y siempre
 * devuelven algo usable — la alternativa (confiar en el modelo) termina en
 * queries con `LIMIT NaN`.
 */

export const readString = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args?.[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
};

export const readNumber = (
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = args?.[key];
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
};

export const readInt = (
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => Math.trunc(readNumber(args, key, fallback, min, max));

/**
 * Lee una fecha `YYYY-MM-DD` válida de calendario. Cualquier cosa distinta
 * (formato raro, 2026-02-31, texto libre) devuelve `undefined` para que el
 * caller aplique su default.
 */
export const readDate = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = readString(args, key);
  if (!value) {
    return undefined;
  }
  return isValidDateString(value) ? value : undefined;
};

/**
 * Normaliza el rango que pide el modelo: si falta o está invertido lo corrige,
 * y lo acota a `maxDays` para que una pregunta como "dame los últimos 10 años"
 * no dispare una query gigante.
 */
export const readDateRange = (
  args: Record<string, unknown>,
  today: string,
  maxDays = 366,
): { from: string; to: string } => {
  const from = readDate(args, 'from');
  const to = readDate(args, 'to');

  if (!from && !to) {
    return { from: today, to: today };
  }
  if (from && !to) {
    return { from, to: from > today ? from : today };
  }
  if (!from && to) {
    return { from: to, to };
  }

  const [start, end] = (from as string) <= (to as string) ? [from, to] : [to, from];
  const startMs = Date.parse(`${start as string}T00:00:00Z`);
  const endMs = Date.parse(`${end as string}T00:00:00Z`);
  const days = Math.floor((endMs - startMs) / 86_400_000) + 1;
  if (days > maxDays) {
    const cappedStart = new Date(endMs - (maxDays - 1) * 86_400_000).toISOString().slice(0, 10);
    return { from: cappedStart, to: end as string };
  }
  return { from: start as string, to: end as string };
};
