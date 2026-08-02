import { readDate, readDateRange, readInt, readNumber, readString } from '../internal/tool-args';

describe('readString', () => {
  it('recorta y descarta vacíos', () => {
    expect(readString({ q: '  arroz ' }, 'q')).toBe('arroz');
    expect(readString({ q: '   ' }, 'q')).toBeUndefined();
    expect(readString({}, 'q')).toBeUndefined();
  });

  it('acepta números como texto (el modelo a veces los manda así)', () => {
    expect(readString({ q: 123 }, 'q')).toBe('123');
    expect(readString({ q: Number.NaN }, 'q')).toBeUndefined();
  });

  it('ignora tipos que no son texto', () => {
    expect(readString({ q: { a: 1 } }, 'q')).toBeUndefined();
    expect(readString({ q: null }, 'q')).toBeUndefined();
  });
});

describe('readNumber / readInt', () => {
  it('acota al rango pedido', () => {
    expect(readNumber({ n: 999 }, 'n', 5, 0, 50)).toBe(50);
    expect(readNumber({ n: -3 }, 'n', 5, 0, 50)).toBe(0);
  });

  it('usa el fallback ante basura', () => {
    expect(readNumber({ n: 'muchos' }, 'n', 5, 0, 50)).toBe(5);
    expect(readNumber({}, 'n', 5, 0, 50)).toBe(5);
    expect(readNumber({ n: Number.POSITIVE_INFINITY }, 'n', 5, 0, 50)).toBe(5);
  });

  it('parsea números enviados como texto', () => {
    expect(readNumber({ n: '12.5' }, 'n', 5, 0, 50)).toBe(12.5);
    expect(readInt({ n: '12.9' }, 'n', 5, 0, 50)).toBe(12);
  });
});

describe('readDate', () => {
  it('acepta fechas válidas', () => {
    expect(readDate({ d: '2026-07-28' }, 'd')).toBe('2026-07-28');
  });

  it('rechaza formatos raros y fechas de calendario imposibles', () => {
    expect(readDate({ d: '28/07/2026' }, 'd')).toBeUndefined();
    expect(readDate({ d: '2026-02-31' }, 'd')).toBeUndefined();
    expect(readDate({ d: 'ayer' }, 'd')).toBeUndefined();
    expect(readDate({}, 'd')).toBeUndefined();
  });
});

describe('readDateRange', () => {
  const today = '2026-07-28';

  it('sin fechas devuelve el día de hoy', () => {
    expect(readDateRange({}, today)).toEqual({ from: today, to: today });
  });

  it('con solo "from" cierra el rango en hoy', () => {
    expect(readDateRange({ from: '2026-07-01' }, today)).toEqual({ from: '2026-07-01', to: today });
  });

  it('con un "from" futuro no genera un rango invertido', () => {
    expect(readDateRange({ from: '2026-09-01' }, today)).toEqual({
      from: '2026-09-01',
      to: '2026-09-01',
    });
  });

  it('con solo "to" usa ese mismo día', () => {
    expect(readDateRange({ to: '2026-07-10' }, today)).toEqual({
      from: '2026-07-10',
      to: '2026-07-10',
    });
  });

  it('corrige un rango invertido', () => {
    expect(readDateRange({ from: '2026-07-20', to: '2026-07-01' }, today)).toEqual({
      from: '2026-07-01',
      to: '2026-07-20',
    });
  });

  it('acota rangos absurdos al máximo de días', () => {
    const range = readDateRange({ from: '2000-01-01', to: '2026-07-28' }, today, 30);
    expect(range.to).toBe('2026-07-28');
    expect(range.from).toBe('2026-06-29');
  });

  it('ignora fechas inválidas y cae al default', () => {
    expect(readDateRange({ from: 'el mes pasado', to: '??' }, today)).toEqual({
      from: today,
      to: today,
    });
  });
});
