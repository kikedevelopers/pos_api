import { BadRequestException } from '@nestjs/common';

/**
 * Helpers de validación de fechas para `reports/*`. Idéntica semántica a la
 * del módulo `dashboard/internal/date-range.ts`. Se duplica acá para mantener
 * los módulos auto-contenidos (no cross-module imports innecesarios).
 */
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
  return {
    from: fromStr,
    to: toStr,
    dateStart: new Date(`${fromStr}T00:00:00.000Z`),
    dateEnd: new Date(`${toStr}T23:59:59.999Z`),
  };
}

export function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
