import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';

/**
 * Inicio del día SIGUIENTE en hora Colombia, como instante absoluto. Es el fin
 * de la pausa cuando un humano toma el control de un chat: el agente vuelve a
 * atender ese chat a partir de la medianoche (Bogotá).
 *
 * Se arma desde la fecha en texto para no depender del `startOf` con zona.
 */
export const nextDayStartBogota = (now: Date = new Date()): Date => {
  const tomorrow = dayjs(now).tz(APP_TIMEZONE).add(1, 'day').format('YYYY-MM-DD');
  return dayjs.tz(`${tomorrow} 00:00:00`, APP_TIMEZONE).toDate();
};
