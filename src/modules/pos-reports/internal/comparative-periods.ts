import type { ComparativeGranularity } from '../dto/comparative-report-query.dto';

/**
 * Cálculo de períodos del Informe Comparativo. TODA la matemática de fechas es
 * en UTC y debe ser IDÉNTICA a la implementación offline de PlacePos: los
 * números del comparativo cloud deben coincidir con los del desktop.
 *
 * Convención de fechas: trabajamos con strings `YYYY-MM-DD` (solo fecha) y un
 * cursor `Date` en UTC. Cada rango luego se materializa como
 * `[from 00:00:00.000Z, to 23:59:59.999Z]` (igual que `parseDateRange` del
 * dashboard) en la capa de métricas.
 */

const MONTH_NAMES_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

/** Capitaliza la primera letra (es-CO): "enero" → "Enero". */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Construye una fecha UTC a partir de componentes (mes 0-indexado). */
function utcDate(year: number, monthIndex0: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex0, day, 0, 0, 0, 0));
}

/** Parsea `YYYY-MM-DD` a un `Date` UTC a medianoche. */
export function parseDateOnlyUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Formatea un `Date` UTC a `YYYY-MM-DD`. */
export function formatDateOnlyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Suma `days` días (UTC) a un `Date` y devuelve uno nuevo. */
export function addDaysUtc(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Días enteros entre dos fechas (UTC), por diferencia de medianoches. */
export function diffDays(from: Date, to: Date): number {
  const fromMid = utcDate(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const toMid = utcDate(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((toMid.getTime() - fromMid.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Lunes (ISO) de la semana que contiene a `ref`. getUTCDay(): domingo=0 ..
 * sábado=6; lunes ISO = restar (day+6)%7 días.
 */
function isoMonday(ref: Date): Date {
  const day = ref.getUTCDay();
  const delta = (day + 6) % 7;
  return addDaysUtc(utcDate(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()), -delta);
}

/** Primer mes del trimestre (0-indexado): ene→0, abr→3, jul→6, oct→9. */
function quarterStartMonth(monthIndex0: number): number {
  return Math.floor(monthIndex0 / 3) * 3;
}

export interface PeriodRange {
  from: string; // YYYY-MM-DD inclusivo
  to: string; // YYYY-MM-DD inclusivo
}

/** Último día del mes de `date` (UTC). */
function endOfMonth(date: Date): Date {
  // Día 0 del mes siguiente = último día del mes actual.
  return utcDate(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
}

/**
 * Inicio del período ACTUAL (start[0]) que contiene a `reference`, según
 * granularity. Idéntico al cálculo de `curStart` de v1 (espejo offline).
 */
export function computeCurrentStart(reference: string, granularity: ComparativeGranularity): Date {
  const ref = parseDateOnlyUtc(reference);
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth(); // 0-indexado
  const dom = ref.getUTCDate();

  switch (granularity) {
    case 'weekly':
      return isoMonday(ref);
    case 'biweekly':
      // <=15 → día 1 del mes; >15 → día 16 del mes.
      return dom <= 15 ? utcDate(year, month, 1) : utcDate(year, month, 16);
    case 'monthly':
      return utcDate(year, month, 1);
    case 'quarterly':
      return utcDate(year, quarterStartMonth(month), 1);
    case 'semiannual':
      // <=junio (month<=5) → ene1; >junio → jul1.
      return utcDate(year, month <= 5 ? 0 : 6, 1);
    case 'annual':
      return utcDate(year, 0, 1);
    default: {
      const _never: never = granularity;
      throw new Error(`granularity no soportada: ${String(_never)}`);
    }
  }
}

/**
 * Inicio del período INMEDIATAMENTE ANTERIOR a uno cuyo inicio es `start`.
 * Idéntico al cálculo de `prevStart` de v1 (espejo offline). Se itera para
 * navegar N períodos hacia atrás.
 */
export function computePreviousStart(start: Date, granularity: ComparativeGranularity): Date {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const dom = start.getUTCDate();

  switch (granularity) {
    case 'weekly':
      return addDaysUtc(start, -7);
    case 'biweekly': {
      if (dom === 1) {
        // Bloque 1..15 → anterior = día 16 del mes ANTERIOR.
        const prevMonth = month === 0 ? 11 : month - 1;
        const prevYear = month === 0 ? year - 1 : year;
        return utcDate(prevYear, prevMonth, 16);
      }
      // Bloque 16.. → anterior = día 1 del MISMO mes.
      return utcDate(year, month, 1);
    }
    case 'monthly': {
      const prevMonth = month === 0 ? 11 : month - 1;
      const prevYear = month === 0 ? year - 1 : year;
      return utcDate(prevYear, prevMonth, 1);
    }
    case 'quarterly': {
      const prevQStartMonth = month - 3;
      return prevQStartMonth < 0
        ? utcDate(year - 1, prevQStartMonth + 12, 1)
        : utcDate(year, prevQStartMonth, 1);
    }
    case 'semiannual':
      // month es 0 (ene1) o 6 (jul1) por construcción de un inicio de semestre.
      return month === 0 ? utcDate(year - 1, 6, 1) : utcDate(year, 0, 1);
    case 'annual':
      return utcDate(year - 1, 0, 1);
    default: {
      const _never: never = granularity;
      throw new Error(`granularity no soportada: ${String(_never)}`);
    }
  }
}

/**
 * Fin NATURAL del período cuyo inicio es `start` (período completo, NO "a la
 * fecha"). Usado para períodos con `offset>0`.
 *
 *   weekly: S+6d; biweekly: si S.day==1 → día 15 del mes, si S.day==16 → último
 *   día del mes; monthly: último día del mes; quarterly: último día del
 *   trimestre; semiannual: último día del semestre; annual: 31-dic del año.
 */
export function naturalPeriodEnd(start: Date, granularity: ComparativeGranularity): Date {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const dom = start.getUTCDate();

  switch (granularity) {
    case 'weekly':
      return addDaysUtc(start, 6);
    case 'biweekly':
      // S.day==1 → día 15 del mes; S.day==16 → último día del mes.
      return dom === 1 ? utcDate(year, month, 15) : endOfMonth(start);
    case 'monthly':
      return endOfMonth(start);
    case 'quarterly': {
      // Último día del trimestre = día 0 del mes que sigue al trimestre.
      const qStart = quarterStartMonth(month);
      return utcDate(year, qStart + 3, 0);
    }
    case 'semiannual': {
      // month es 0 o 6. Fin = día 0 del mes que sigue al semestre.
      const semStartMonth = month === 0 ? 0 : 6;
      return utcDate(year, semStartMonth + 6, 0);
    }
    case 'annual':
      return utcDate(year, 11, 31);
    default: {
      const _never: never = granularity;
      throw new Error(`granularity no soportada: ${String(_never)}`);
    }
  }
}

export interface SubBucketDef {
  label: string;
  /** offset en días desde el inicio del rango (aplica a current y previous). */
  offsetStart: number;
  /** offset en días (inclusivo) del último día del sub-bucket. */
  offsetEnd: number;
}

/**
 * Define los sub-buckets del breakdown alineados por índice entre previous y
 * current (ambos rangos duran lo mismo). El último bucket puede ser parcial.
 *
 *   - weekly / biweekly: por DÍA. label "Día N".
 *   - monthly: por SEMANA (bloques de 7 días, offset//7). label "Semana N".
 *   - quarterly / semiannual / annual: por MES calendario dentro del rango.
 *     label = nombre del mes es-CO (+ año si el rango cruza años).
 */
export function buildSubBuckets(
  granularity: ComparativeGranularity,
  curStart: Date,
  elapsedDays: number,
): SubBucketDef[] {
  // totalDays = nº de días inclusivos del rango (elapsedDays es la diferencia).
  const totalDays = elapsedDays + 1;

  if (granularity === 'weekly' || granularity === 'biweekly') {
    const buckets: SubBucketDef[] = [];
    for (let offset = 0; offset < totalDays; offset += 1) {
      buckets.push({ label: `Día ${offset + 1}`, offsetStart: offset, offsetEnd: offset });
    }
    return buckets;
  }

  if (granularity === 'monthly') {
    const buckets: SubBucketDef[] = [];
    let weekIndex = 0;
    for (let offset = 0; offset < totalDays; offset += 7) {
      const offsetEnd = Math.min(offset + 6, totalDays - 1);
      weekIndex += 1;
      buckets.push({ label: `Semana ${weekIndex}`, offsetStart: offset, offsetEnd });
    }
    return buckets;
  }

  // quarterly / semiannual / annual: por MES calendario dentro del rango.
  // Determinamos si el rango cruza años para decidir si el label incluye año.
  const lastDay = addDaysUtc(curStart, totalDays - 1);
  const crossesYears = curStart.getUTCFullYear() !== lastDay.getUTCFullYear();

  const buckets: SubBucketDef[] = [];
  let cursor = utcDate(curStart.getUTCFullYear(), curStart.getUTCMonth(), curStart.getUTCDate());
  while (diffDays(curStart, cursor) <= totalDays - 1) {
    const monthIndex0 = cursor.getUTCMonth();
    const yearOfCursor = cursor.getUTCFullYear();
    // Primer día del MES SIGUIENTE para acotar el bucket dentro del rango.
    const nextMonthStart = utcDate(yearOfCursor, monthIndex0 + 1, 1);
    const offsetStart = diffDays(curStart, cursor);
    // offsetEnd = min(día previo al próximo mes, último día del rango).
    const offsetEndCandidate = diffDays(curStart, nextMonthStart) - 1;
    const offsetEnd = Math.min(offsetEndCandidate, totalDays - 1);
    const monthLabel = capitalize(MONTH_NAMES_ES[monthIndex0]);
    const label = crossesYears ? `${monthLabel} ${yearOfCursor}` : monthLabel;
    buckets.push({ label, offsetStart, offsetEnd });
    cursor = nextMonthStart;
  }
  return buckets;
}

/** Abreviaturas de mes es-CO (3 letras, minúscula) — para label weekly. */
const MONTH_ABBR_ES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const;

/**
 * Label CONCRETO es-CO del período cuyo inicio es `start` (v2 — sin
 * "actual/anterior"). Idéntico en offline:
 *
 *   monthly:    "Junio 2026"
 *   annual:     "2026"
 *   quarterly:  "T<q> <año>"  (q = 1..4 por mes de inicio)
 *   semiannual: "S<s> <año>"  (s = 1..2)
 *   biweekly:   "<1ª|2ª> quincena <Mes> <año>"  (1ª si day==1, 2ª si 16)
 *   weekly:     "Sem. <dd> <mmm>"  (dd = día de inicio 2 dígitos; mmm abrev mes)
 */
export function concretePeriodLabel(granularity: ComparativeGranularity, start: Date): string {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const dom = start.getUTCDate();

  switch (granularity) {
    case 'weekly': {
      const dd = String(dom).padStart(2, '0');
      return `Sem. ${dd} ${MONTH_ABBR_ES[month]}`;
    }
    case 'biweekly': {
      const half = dom === 1 ? '1ª' : '2ª';
      return `${half} quincena ${capitalize(MONTH_NAMES_ES[month])} ${year}`;
    }
    case 'monthly':
      return `${capitalize(MONTH_NAMES_ES[month])} ${year}`;
    case 'quarterly': {
      const q = Math.floor(month / 3) + 1;
      return `T${q} ${year}`;
    }
    case 'semiannual': {
      const s = month <= 5 ? 1 : 2;
      return `S${s} ${year}`;
    }
    case 'annual':
      return `${year}`;
    default: {
      const _never: never = granularity;
      throw new Error(`granularity no soportada: ${String(_never)}`);
    }
  }
}
