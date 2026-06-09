import { dayjs, APP_TIMEZONE } from '@/common/utils/dayjs';

import type { FixedExpensePeriodUnit } from '../entities/fixed-expense.entity';

/**
 * Algoritmo canónico de cortes (§2 del contrato compartido
 * `CONTRACT_fixed_expenses_calendar.md`).
 *
 * DEBE producir EXACTAMENTE los mismos instantes de corte y montos que las
 * otras dos implementaciones (`placepos/src/renderer` y `placepos/src/main`).
 * Cualquier cambio aquí rompe la paridad de datos cloud ↔ offline.
 *
 * Dos familias de periodicidad:
 *   - Legacy (`hour | day | week | month`): intervalo de horas FIJO. `month`
 *     = 30 días exactos. `period_quantity` multiplica. NO se toca el cálculo
 *     histórico — instantes en horas absolutas, sin zona horaria.
 *   - Calendario (`semimonthly | end_of_month`): anclajes calculados en zona
 *     `America/Bogota` con dayjs (utc + timezone). `period_quantity` se IGNORA.
 *       * `end_of_month`: un corte el último día de cada mes (23:59:59.999).
 *       * `semimonthly`: dos cortes por mes — día 15 y último día.
 *     `amount(n)` SIEMPRE = monto completo (nunca prorratea).
 */

/** Unidades de calendario (anclajes con dayjs tz). */
export const CALENDAR_PERIOD_UNITS = ['semimonthly', 'end_of_month'] as const;

export type CalendarPeriodUnit = (typeof CALENDAR_PERIOD_UNITS)[number];

/** `true` si la unidad usa anclajes de calendario (§2). */
export function isCalendarPeriodUnit(unit: FixedExpensePeriodUnit): unit is CalendarPeriodUnit {
  return (CALENDAR_PERIOD_UNITS as readonly string[]).includes(unit);
}

// ---------------------------------------------------------------------------
// Legacy (horas fijas) — espejo de `syncDuePeriods.ts` offline.
// ---------------------------------------------------------------------------

const MS_PER_HOUR = 3_600_000;

/**
 * Horas por unidad legacy. `month` = 30 días fijos (convención del producto,
 * idéntica a PlacePos). Las unidades de calendario NO viven aquí.
 */
const HOURS_PER_LEGACY_UNIT: Record<string, number> = {
  hour: 1,
  day: 24,
  week: 24 * 7,
  month: 24 * 30,
};

interface LegacyScheduleInput {
  period_unit: FixedExpensePeriodUnit;
  period_quantity: number;
  start_date: Date;
}

function legacyPeriodHours(input: LegacyScheduleInput): number {
  const hours = HOURS_PER_LEGACY_UNIT[input.period_unit];
  if (hours === undefined) {
    return 0;
  }
  return input.period_quantity * hours;
}

/** `due_at(n)` legacy = `start + n * periodHours` (1-indexed). */
function legacyDueAt(input: LegacyScheduleInput, n: number): Date {
  return new Date(input.start_date.getTime() + n * legacyPeriodHours(input) * MS_PER_HOUR);
}

/** Cantidad de cortes completados (vencidos) hasta `now` para legacy. */
function legacyCompletedPeriods(input: LegacyScheduleInput, now: Date): number {
  const total = legacyPeriodHours(input);
  if (total <= 0) {
    return 0;
  }
  const elapsedHours = (now.getTime() - input.start_date.getTime()) / MS_PER_HOUR;
  if (elapsedHours <= 0) {
    return 0;
  }
  return Math.floor(elapsedHours / total);
}

// ---------------------------------------------------------------------------
// Calendario (anclajes dayjs tz Bogotá) — §2.1 / §2.2.
// ---------------------------------------------------------------------------

/**
 * Anclajes de un mes dado (año `y`, mes 1-indexed `m`) según la convención.
 * Devueltos en orden cronológico, como instantes absolutos (`Date`/UTC).
 *
 *   - ancla "día 15"   = `dayjs.tz('y-m-15').endOf('day')`   → 15 23:59:59.999 Bogotá
 *   - ancla "fin de mes" = `dayjs.tz('y-m-01').endOf('month')` → últimoDía 23:59:59.999 Bogotá
 */
function monthAnchors(unit: CalendarPeriodUnit, y: number, m: number): Date[] {
  const mm = String(m).padStart(2, '0');
  const endOfMonth = dayjs.tz(`${y}-${mm}-01`, APP_TIMEZONE).endOf('month').toDate();

  if (unit === 'end_of_month') {
    return [endOfMonth];
  }

  // semimonthly: día 15 (fin del día) + fin de mes, en orden cronológico.
  const day15 = dayjs.tz(`${y}-${mm}-15`, APP_TIMEZONE).endOf('day').toDate();
  return [day15, endOfMonth];
}

interface CalendarScheduleInput {
  period_unit: CalendarPeriodUnit;
  start_date: Date;
}

/**
 * Genera los primeros `count` anclajes ESTRICTAMENTE posteriores a `start`
 * (§2.2 paso 2: `anchor > start`), en orden ascendente. Recorre mes a mes
 * desde el mes de `start` hacia adelante.
 *
 * Crear el gasto justo en un anclaje NO dispara corte inmediato (`>`, no `>=`).
 */
export function calendarAnchorsAfter(input: CalendarScheduleInput, count: number): Date[] {
  if (count <= 0) {
    return [];
  }

  const startMs = input.start_date.getTime();
  const startBogota = dayjs(input.start_date).tz(APP_TIMEZONE);

  let y = startBogota.year();
  let m = startBogota.month() + 1; // dayjs.month() es 0-indexed.

  const anchors: Date[] = [];
  // Cota de seguridad: como mucho 2 anclajes por mes, recorremos meses hasta
  // juntar `count`. El límite evita un loop infinito ante datos corruptos.
  const maxMonths = count * 2 + 24;
  let monthsScanned = 0;

  while (anchors.length < count && monthsScanned < maxMonths) {
    for (const anchor of monthAnchors(input.period_unit, y, m)) {
      if (anchor.getTime() > startMs) {
        anchors.push(anchor);
        if (anchors.length >= count) {
          break;
        }
      }
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    monthsScanned += 1;
  }

  return anchors;
}

/**
 * `completedPeriods(now)` para calendario = cantidad de anclajes `a_k <= now`
 * (§2.2 paso 4). Avanza mes a mes contando anclajes `> start` y `<= now`.
 */
export function calendarCompletedPeriods(input: CalendarScheduleInput, now: Date): number {
  const startMs = input.start_date.getTime();
  const nowMs = now.getTime();
  if (nowMs <= startMs) {
    return 0;
  }

  const startBogota = dayjs(input.start_date).tz(APP_TIMEZONE);
  let y = startBogota.year();
  let m = startBogota.month() + 1;

  let completed = 0;
  // Recorremos hasta pasar `now`. El mes de `now` aún puede aportar anclajes.
  const nowBogota = dayjs(now).tz(APP_TIMEZONE);
  const lastMonthIndex = (nowBogota.year() + 1) * 12 + nowBogota.month(); // +1 año de colchón
  while (y * 12 + (m - 1) <= lastMonthIndex) {
    for (const anchor of monthAnchors(input.period_unit, y, m)) {
      const t = anchor.getTime();
      if (t > startMs && t <= nowMs) {
        completed += 1;
      }
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  return completed;
}

// ---------------------------------------------------------------------------
// API unificada del schedule.
// ---------------------------------------------------------------------------

export interface ScheduleExpense {
  period_unit: FixedExpensePeriodUnit;
  period_quantity: number;
  start_date: Date;
  /** Monto por corte. SIEMPRE completo (nunca prorratea — §1/§2.2). */
  amount: number;
}

/**
 * Cantidad de cortes vencidos (`due_at <= now`) que DEBERÍAN existir para el
 * gasto dado. Espejo de `expectedCompletedPeriods` offline + branch calendario.
 */
export function expectedCompletedPeriods(expense: ScheduleExpense, now: Date): number {
  if (isCalendarPeriodUnit(expense.period_unit)) {
    return calendarCompletedPeriods(
      { period_unit: expense.period_unit, start_date: expense.start_date },
      now,
    );
  }
  return legacyCompletedPeriods(expense, now);
}

/**
 * `due_at(n)` para el corte `n` (1-indexed) del gasto. Para calendario resuelve
 * el n-ésimo anclaje `> start`; para legacy `start + n * periodHours`.
 */
export function dueAtForPeriod(expense: ScheduleExpense, n: number): Date {
  if (isCalendarPeriodUnit(expense.period_unit)) {
    const anchors = calendarAnchorsAfter(
      { period_unit: expense.period_unit, start_date: expense.start_date },
      n,
    );
    const anchor = anchors[n - 1];
    if (!anchor) {
      throw new Error(`No se pudo resolver el anclaje de calendario para n=${n}`);
    }
    return anchor;
  }
  return legacyDueAt(expense, n);
}

/**
 * `amount(n)` = monto completo del gasto, SIEMPRE (§1/§2.2). El branch existe
 * por simetría con `dueAtForPeriod` y para dejar explícita la regla "nunca
 * prorratea ni el primer periodo parcial".
 */
export function amountForPeriod(expense: ScheduleExpense): number {
  return expense.amount;
}
