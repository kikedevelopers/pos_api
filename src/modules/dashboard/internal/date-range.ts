import { BadRequestException } from '@nestjs/common';

/**
 * Helpers de rango de fechas para los reportes y dashboard.
 *
 * Política de validación:
 *   - Formato estricto YYYY-MM-DD.
 *   - Rango cerrado [from, to] en UTC.
 *   - `to >= from`.
 *   - Máximo 366 días (espejo PlacePos `MAX_RANGE_DAYS`).
 *
 * Las dates inválidas lanzan `BadRequestException` (mapeado por el filter
 * global a `400 { success: false, error: '...' }`).
 */
export const MAX_RANGE_DAYS = 366;

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(value: string | undefined | null): value is string {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  // Reject NaN dates (e.g. 2026-13-99).
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  // Validate that the parsed date matches the input (rejects 2026-02-31 silently rolled).
  const iso = parsed.toISOString().slice(0, 10);
  return iso === value;
}

export interface DateRange {
  from: string;
  to: string;
  dateStart: Date;
  dateEnd: Date;
}

/**
 * Construye el rango UTC [from 00:00:00, to 23:59:59.999]. Valida formato y
 * límite de 366 días.
 */
export function parseDateRange(fromStr: string, toStr: string): DateRange {
  if (!isValidDateString(fromStr) || !isValidDateString(toStr)) {
    throw new BadRequestException('Formato de fecha inválido (YYYY-MM-DD)');
  }
  if (toStr < fromStr) {
    throw new BadRequestException('"to" no puede ser anterior a "from"');
  }
  const dateStart = new Date(`${fromStr}T00:00:00.000Z`);
  const dateEnd = new Date(`${toStr}T23:59:59.999Z`);
  const diffMs = dateEnd.getTime() - dateStart.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestException(`Rango máximo permitido: ${MAX_RANGE_DAYS} días`);
  }
  return { from: fromStr, to: toStr, dateStart, dateEnd };
}

/**
 * Devuelve la fecha actual en formato `YYYY-MM-DD` en UTC. Usado para
 * defaults de `from`/`to` cuando el cliente no los envía.
 */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Devuelve `today - days` como `YYYY-MM-DD` UTC.
 */
export function daysAgoUtc(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Primer día del mes (UTC) en `YYYY-MM-DD`.
 */
export function startOfMonthUtc(reference: string = todayUtc()): string {
  return `${reference.slice(0, 7)}-01`;
}

/**
 * Lista de fechas `YYYY-MM-DD` entre `from` y `to` (inclusivo).
 */
export function buildDateList(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}
