import { UnprocessableEntityException } from '@nestjs/common';

import { dayjs } from '@/common/utils/dayjs';

import { resolvePaymentDueAt } from '../payment-due';

/**
 * Plazo de pago de una compra: el cliente manda el DÍA (calendario de
 * Colombia) y el server lo fija al final de ese día en Bogotá. Nunca puede
 * quedar en un día anterior a hoy.
 */
describe('resolvePaymentDueAt', () => {
  // 22-oct-2026 10:00 a. m. en Bogotá (15:00 UTC).
  const now = dayjs.tz('2026-10-22 10:00:00', 'America/Bogota');

  it('sin plazo (undefined o null) → null', () => {
    expect(resolvePaymentDueAt(undefined, now)).toBeNull();
    expect(resolvePaymentDueAt(null, now)).toBeNull();
  });

  it('un día futuro vence al final de ese día en Bogotá (23:59:59.999)', () => {
    const due = resolvePaymentDueAt('2026-11-06', now);
    // 06-nov 23:59:59.999 Bogotá (UTC-5) = 07-nov 04:59:59.999 UTC.
    expect(due?.toISOString()).toBe('2026-11-07T04:59:59.999Z');
  });

  it('hoy es válido y vence a las 23:59:59 de hoy', () => {
    const due = resolvePaymentDueAt('2026-10-22', now);
    expect(due?.toISOString()).toBe('2026-10-23T04:59:59.999Z');
  });

  it('el "hoy" se mide en Bogotá, no en UTC (a las 9 p. m. Bogotá ya es mañana en UTC)', () => {
    // 22-oct 21:00 Bogotá = 23-oct 02:00 UTC: hoy sigue siendo el 22.
    const late_night = dayjs.tz('2026-10-22 21:00:00', 'America/Bogota');
    expect(resolvePaymentDueAt('2026-10-22', late_night)?.toISOString()).toBe(
      '2026-10-23T04:59:59.999Z',
    );
  });

  it('rechaza un día anterior a hoy con 422', () => {
    expect(() => resolvePaymentDueAt('2026-10-21', now)).toThrow(UnprocessableEntityException);
    expect(() => resolvePaymentDueAt('2026-10-21', now)).toThrow(
      'El plazo de pago no puede ser una fecha anterior a hoy',
    );
  });

  it('rechaza fechas imposibles o mal formadas con 422', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '06/11/2026', 'mañana', '']) {
      expect(() => resolvePaymentDueAt(bad, now)).toThrow(
        'El plazo de pago no es una fecha válida',
      );
    }
  });

  it('cruza fin de año y años bisiestos correctamente', () => {
    expect(resolvePaymentDueAt('2026-12-31', now)?.toISOString()).toBe('2027-01-01T04:59:59.999Z');
    expect(resolvePaymentDueAt('2028-02-29', now)?.toISOString()).toBe('2028-03-01T04:59:59.999Z');
  });
});
