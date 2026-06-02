import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

/**
 * Configuración GLOBAL de dayjs para todo pos_api.
 *
 * Regla del proyecto: TODA fecha/hora se maneja con dayjs (nunca `new Date()`
 * crudo para lógica de negocio), y la zona horaria por DEFECTO es Colombia
 * (`America/Bogota`, UTC-5, sin DST). Las columnas `timestamptz` se guardan en
 * UTC; al filtrar "hoy" / rangos de día hay que convertir los límites del día
 * COLOMBIANO al instante UTC correspondiente — para eso es `dayjs.tz(...)`.
 *
 * Importar SIEMPRE `dayjs` desde este módulo (no desde 'dayjs' directo) para
 * garantizar que los plugins y el default timezone estén aplicados.
 */
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

/** Zona horaria del negocio. UTC-5 fijo (Colombia no aplica horario de verano). */
export const APP_TIMEZONE = 'America/Bogota';

// Default global: dayjs.tz('2026-06-02 00:00:00') interpreta el string EN Bogota.
dayjs.tz.setDefault(APP_TIMEZONE);

/** `now` en zona Colombia. */
export function nowBogota(): dayjs.Dayjs {
  return dayjs().tz(APP_TIMEZONE);
}

export { dayjs };
