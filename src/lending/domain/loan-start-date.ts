import { BadRequestException } from '@nestjs/common';

import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';

/** Hoy en el día del negocio (Bogotá), `YYYY-MM-DD`. `now` se inyecta en tests. */
export const businessToday = (now: Date = new Date()): string =>
  dayjs(now).tz(APP_TIMEZONE).format('YYYY-MM-DD');

/**
 * Fecha de inicio del préstamo: por defecto hoy; si llega, debe ser una fecha
 * REAL (no "2026-02-30") y no puede estar en el futuro (se registran préstamos
 * ya hechos, no se agendan). 400 con mensaje para el usuario.
 */
export function resolveLoanStartDate(input: string | undefined, now?: Date): string {
  const today = businessToday(now);
  if (input === undefined || input === '') return today;
  const parsed = new Date(`${input}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) {
    throw new BadRequestException('La fecha de inicio no es una fecha válida.');
  }
  if (input > today) {
    throw new BadRequestException('La fecha de inicio no puede ser posterior a hoy.');
  }
  return input;
}
