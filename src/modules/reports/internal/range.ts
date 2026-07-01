import { BadRequestException } from '@nestjs/common';

import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';

/**
 * Helpers de validación de fechas para `reports/*` y `pos-reports/*`.
 * Idéntica semántica a la del módulo `dashboard/internal/date-range.ts`.
 *
 * Política (regla del proyecto): TODO con dayjs y en zona **Colombia**
 * (`America/Bogota`, UTC-5). "Hoy" = el día CALENDARIO colombiano, no UTC.
 *   - Formato estricto YYYY-MM-DD.
 *   - El rango cerrado [from, to] se interpreta como días COLOMBIANOS; sus
 *     límites se convierten al instante UTC correspondiente (`timestamptz` se
 *     guarda en UTC), así un abono/venta de la tarde-noche (≥19:00 Colombia)
 *     cae en el día calendario colombiano correcto y NO en el "hoy" de UTC.
 *   - `to >= from`.
 *   - Máximo `MAX_RANGE_DAYS` días (espejo PlacePos `MAX_RANGE_DAYS=366`).
 *     HIGH-2 auditoría Fase 11: sin límite, una query de varios años hace DoS
 *     porque las actions iteran el summary en memoria.
 *
 * Nota: los nombres conservan el sufijo histórico (`parseUtcRange`,
 * `todayUtcDate`, `UtcDateRange`) por compatibilidad de imports, pero AHORA
 * operan en hora Colombia (misma semántica que `date-range.ts`).
 *
 * Se duplica vs `dashboard/internal/date-range.ts` para mantener módulos
 * auto-contenidos. Si se decide consolidar, mover a `common/utils/`.
 */
export const MAX_RANGE_DAYS = 366;

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) {
    return false;
  }
  // Validación de formato/calendario (independiente de zona): rechaza
  // 2026-13-99 / 2026-02-31. dayjs strict con el formato exacto.
  const parsed = dayjs(value, 'YYYY-MM-DD', true);
  return parsed.isValid() && parsed.format('YYYY-MM-DD') === value;
}

export interface UtcDateRange {
  from: string;
  to: string;
  dateStart: Date;
  dateEnd: Date;
}

/**
 * Construye el rango como días COLOMBIANOS: [from 00:00:00 Bogota,
 * to 23:59:59.999 Bogota] convertidos al instante UTC. Valida formato y el
 * límite de `MAX_RANGE_DAYS` días.
 */
export function parseUtcRange(fromStr: string, toStr: string): UtcDateRange {
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
 * Fecha actual `YYYY-MM-DD` en hora Colombia. Default de `date`/`to` cuando el
 * cliente no los envía.
 */
export function todayUtcDate(): string {
  return dayjs().tz(APP_TIMEZONE).format('YYYY-MM-DD');
}
