import { BadRequestException } from '@nestjs/common';

import { dayjs, APP_TIMEZONE } from '@/common/utils/dayjs';

import { MAX_RANGE_DAYS, isValidDateString, parseUtcRange, todayUtcDate } from '../internal/range';

/**
 * Tests del helper de rango de `reports/*` tras UNIFICAR la zona horaria a
 * America/Bogota (antes construía límites en UTC puro con `T00:00:00.000Z`).
 *
 * El nombre `parseUtcRange` se conserva por compatibilidad de imports, pero AHORA
 * los límites del día son días CALENDARIO colombianos (UTC-5). Este cambio afecta
 * daily-closure, credits y pos-reports (dashboard-sales / sales-report).
 */
describe('reports/internal/range (zona America/Bogota)', () => {
  it('parseUtcRange construye los límites del día en hora Colombia (UTC-5)', () => {
    const r = parseUtcRange('2026-05-01', '2026-05-31');
    // 2026-05-01 00:00 Colombia = 2026-05-01 05:00Z.
    expect(r.dateStart.toISOString()).toBe('2026-05-01T05:00:00.000Z');
    // 2026-05-31 23:59:59.999 Colombia = 2026-06-01 04:59:59.999Z.
    expect(r.dateEnd.toISOString()).toBe('2026-06-01T04:59:59.999Z');
    expect(r.from).toBe('2026-05-01');
    expect(r.to).toBe('2026-05-31');
  });

  it('un instante de la NOCHE (22:30 Col = 03:30Z del día siguiente) cae en el día colombiano correcto', () => {
    // 2026-03-15 22:30 Colombia → 2026-03-16 03:30Z.
    const nightPayment = new Date('2026-03-16T03:30:00.000Z');

    const day15 = parseUtcRange('2026-03-15', '2026-03-15');
    // Pertenece al 15 colombiano.
    expect(nightPayment >= day15.dateStart && nightPayment <= day15.dateEnd).toBe(true);

    const day16 = parseUtcRange('2026-03-16', '2026-03-16');
    // NO pertenece al 16 colombiano (con la lógica UTC previa sí caía en el 16).
    expect(nightPayment >= day16.dateStart && nightPayment <= day16.dateEnd).toBe(false);
  });

  it('todayUtcDate devuelve HOY en hora Colombia', () => {
    expect(todayUtcDate()).toBe(dayjs().tz(APP_TIMEZONE).format('YYYY-MM-DD'));
  });

  it('valida formato, orden y rango máximo', () => {
    expect(isValidDateString('2026-02-31')).toBe(false); // fecha imposible
    expect(isValidDateString('2026-05-01')).toBe(true);
    expect(() => parseUtcRange('bad', '2026-05-01')).toThrow(BadRequestException);
    expect(() => parseUtcRange('2026-05-31', '2026-05-01')).toThrow(BadRequestException);
    const to = dayjs('2026-01-01', 'YYYY-MM-DD').add(MAX_RANGE_DAYS, 'day').format('YYYY-MM-DD');
    expect(() => parseUtcRange('2026-01-01', to)).toThrow(BadRequestException);
  });
});
