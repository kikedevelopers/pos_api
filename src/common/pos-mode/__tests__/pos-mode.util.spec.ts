import { DEFAULT_POS_MODE, POS_MODES, isPosMode, resolvePosMode } from '../pos-mode.util';

// ---------------------------------------------------------------------------
// Modo del POS por negocio (retail | restaurant).
//
// La regla que importa: cualquier valor que no sea un modo conocido cae en
// `retail`. Un negocio jamás debe quedarse sin POS por un dato raro.
// ---------------------------------------------------------------------------

describe('pos-mode.util', () => {
  it('los modos soportados son retail y restaurant, con retail por defecto', () => {
    expect(POS_MODES).toEqual(['retail', 'restaurant']);
    expect(DEFAULT_POS_MODE).toBe('retail');
  });

  describe('isPosMode', () => {
    it.each(['retail', 'restaurant'])('acepta %s', (mode) => {
      expect(isPosMode(mode)).toBe(true);
    });

    it.each([
      null,
      undefined,
      '',
      'RETAIL',
      'Restaurant',
      ' restaurant',
      'bar',
      0,
      1,
      true,
      {},
      [],
    ])('rechaza %p', (value) => {
      expect(isPosMode(value)).toBe(false);
    });
  });

  describe('resolvePosMode', () => {
    it('conserva un modo válido', () => {
      expect(resolvePosMode('retail')).toBe('retail');
      expect(resolvePosMode('restaurant')).toBe('restaurant');
    });

    it.each([null, undefined, '', 'RESTAURANT', 'bar', 42, {}])(
      'cae en retail ante %p',
      (value) => {
        expect(resolvePosMode(value)).toBe('retail');
      },
    );
  });
});
