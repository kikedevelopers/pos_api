import { BadRequestException } from '@nestjs/common';

/**
 * Helpers de validación de fechas para `reports/*` y `pos-reports/*`.
 * Idéntica semántica a la del módulo `dashboard/internal/date-range.ts`.
 *
 * Política:
 *   - Formato estricto YYYY-MM-DD.
 *   - Rango cerrado [from, to] en UTC.
 *   - `to >= from`.
 *   - Máximo `MAX_RANGE_DAYS` días (espejo PlacePos `MAX_RANGE_DAYS=366`).
 *     HIGH-2 auditoría Fase 11: sin límite, una query de varios años hace DoS
 *     porque las actions iteran el summary en memoria.
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
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.toISOString().slice(0, 10) === value;
}

export interface UtcDateRange {
  from: string;
  to: string;
  dateStart: Date;
  dateEnd: Date;
}

export function parseUtcRange(fromStr: string, toStr: string): UtcDateRange {
  if (!isValidDateString(fromStr) || !isValidDateString(toStr)) {
    throw new BadRequestException('Formato de fecha inválido (YYYY-MM-DD)');
  }
  if (toStr < fromStr) {
    throw new BadRequestException('"to" no puede ser anterior a "from"');
  }
  const dateStart = new Date(`${fromStr}T00:00:00.000Z`);
  const dateEnd = new Date(`${toStr}T23:59:59.999Z`);
  const days = Math.floor((dateEnd.getTime() - dateStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestException(`Rango máximo permitido: ${MAX_RANGE_DAYS} días`);
  }
  return { from: fromStr, to: toStr, dateStart, dateEnd };
}

export function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
