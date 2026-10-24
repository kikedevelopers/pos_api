import { BadRequestException } from '@nestjs/common';

import { businessToday, resolveLoanStartDate } from './loan-start-date';

// 03:00 UTC del 25-oct = 22:00 del 24-oct en Bogotá.
const NIGHT = new Date('2026-10-25T03:00:00Z');

describe('businessToday', () => {
  it('usa el día de Bogotá, no el UTC', () => {
    expect(businessToday(NIGHT)).toBe('2026-10-24');
  });
});

describe('resolveLoanStartDate', () => {
  it('sin fecha (o vacía) es hoy', () => {
    expect(resolveLoanStartDate(undefined, NIGHT)).toBe('2026-10-24');
    expect(resolveLoanStartDate('', NIGHT)).toBe('2026-10-24');
  });

  it('hoy y fechas pasadas pasan tal cual', () => {
    expect(resolveLoanStartDate('2026-10-24', NIGHT)).toBe('2026-10-24');
    expect(resolveLoanStartDate('2025-01-31', NIGHT)).toBe('2025-01-31');
  });

  it.each([
    ['2026-10-25', /posterior a hoy/],
    ['2026-02-30', /no es una fecha válida/],
    ['2026-13-01', /no es una fecha válida/],
  ])('%s → 400', (input, message) => {
    expect(() => resolveLoanStartDate(input, NIGHT)).toThrow(BadRequestException);
    expect(() => resolveLoanStartDate(input, NIGHT)).toThrow(message);
  });
});
