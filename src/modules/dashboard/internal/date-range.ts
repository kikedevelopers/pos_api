import { BadRequestException } from '@nestjs/common';

import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';

/**
 * Helpers de rango de fechas para los reportes y dashboard.
 *
 * Política (regla del proyecto): TODO con dayjs y en zona **Colombia**
 * (`America/Bogota`, UTC-5). "Hoy" = el día CALENDARIO colombiano, no UTC.
 *   - Formato estricto YYYY-MM-DD.
 *   - El rango [from, to] se interpreta como días COLOMBIANOS; sus límites se
 *     convierten al instante UTC correspondiente (`timestamptz` se guarda UTC),
 *     así un gasto/venta de la tarde-noche de ayer NO cae en el "hoy" de hoy.
 *   - `to >= from`. Máximo 366 días (espejo PlacePos `MAX_RANGE_DAYS`).
 *
 * Nota: los nombres conservan el sufijo histórico (`todayUtc`, etc.) por
 * compatibilidad de imports, pero AHORA devuelven la fecha en hora Colombia.
 */
export const MAX_RANGE_DAYS = 366;

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(value: string | undefined | null): value is string {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) {
    return false;
  }
  // Validación de formato/calendario (independiente de zona): rechaza
  // 2026-13-99 / 2026-02-31. dayjs strict con el formato exacto.
  const parsed = dayjs(value, 'YYYY-MM-DD', true);
  return parsed.isValid() && parsed.format('YYYY-MM-DD') === value;
}

export interface DateRange {
  from: string;
  to: string;
  dateStart: Date;
  dateEnd: Date;
}

/**
 * Construye el rango como días COLOMBIANOS: [from 00:00:00 Bogota,
 * to 23:59:59.999 Bogota] convertidos al instante UTC. Valida formato y el
 * límite de 366 días.
 */
export function parseDateRange(fromStr: string, toStr: string): DateRange {
  if (!isValidDateString(fromStr) || !isValidDateString(toStr)) {
    throw new BadRequestException('Formato de fecha inválido (YYYY-MM-DD)');
  }
  if (toStr < fromStr) {
    throw new BadRequestException('"to" no puede ser anterior a "from"');
  }
  // dayjs.tz interpreta el string EN Bogota; .toDate() da el instante UTC.
  const dateStart = dayjs.tz(`${fromStr} 00:00:00.000`, APP_TIMEZONE).toDate();
  const dateEnd = dayjs.tz(`${toStr} 23:59:59.999`, APP_TIMEZONE).toDate();
  const days = dayjs(toStr, 'YYYY-MM-DD').diff(dayjs(fromStr, 'YYYY-MM-DD'), 'day') + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestException(`Rango máximo permitido: ${MAX_RANGE_DAYS} días`);
  }
  return { from: fromStr, to: toStr, dateStart, dateEnd };
}

/**
 * Fecha actual `YYYY-MM-DD` en hora Colombia. Default de `from`/`to` cuando el
 * cliente no los envía.
 */
export function todayUtc(): string {
  return dayjs().tz(APP_TIMEZONE).format('YYYY-MM-DD');
}

/**
 * `today - days` como `YYYY-MM-DD` en hora Colombia.
 */
export function daysAgoUtc(days: number): string {
  return dayjs().tz(APP_TIMEZONE).subtract(days, 'day').format('YYYY-MM-DD');
}

/**
 * Primer día del mes en `YYYY-MM-DD` (opera sobre el string, neutro a zona).
 */
export function startOfMonthUtc(reference: string = todayUtc()): string {
  return `${reference.slice(0, 7)}-01`;
}

/**
 * Lista de fechas `YYYY-MM-DD` entre `from` y `to` (inclusivo). Neutro a zona.
 */
export function buildDateList(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = dayjs(from, 'YYYY-MM-DD');
  const end = dayjs(to, 'YYYY-MM-DD');
  while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
    dates.push(cursor.format('YYYY-MM-DD'));
    cursor = cursor.add(1, 'day');
  }
  return dates;
}
