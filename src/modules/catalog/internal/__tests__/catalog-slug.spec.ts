import {
  normalizeSlug,
  SLUG_PATTERN,
  slugRejectionMessage,
  validateSlug,
} from '../catalog-slug';

describe('normalizeSlug', () => {
  it('convierte una frase con mayúsculas, espacios y acentos en una sola palabra', () => {
    expect(normalizeSlug('Esencia y Grano')).toBe('esenciaygrano');
    expect(normalizeSlug('  Café  Döner  ')).toBe('cafedoner');
    expect(normalizeSlug('ÁÉÍÓÚ')).toBe('aeiou');
  });

  it('elimina símbolos y signos de puntuación', () => {
    expect(normalizeSlug('mi-negocio_2024!')).toBe('minegocio2024');
    expect(normalizeSlug('@tienda.online')).toBe('tiendaonline');
  });

  it('la ñ se descompone (NFD) y queda como n — resultado ASCII', () => {
    expect(normalizeSlug('piñata')).toBe('pinata');
  });

  it('una entrada sin caracteres válidos queda vacía', () => {
    expect(normalizeSlug('   ---   ')).toBe('');
    expect(normalizeSlug('✨🎉')).toBe('');
  });

  it('lo que normaliza siempre cumple el patrón canónico (si no está vacío ni es muy corto)', () => {
    const slug = normalizeSlug('La 21 Market');
    expect(slug).toBe('la21market');
    expect(SLUG_PATTERN.test(slug)).toBe(true);
  });
});

describe('validateSlug', () => {
  it('acepta y devuelve el slug normalizado', () => {
    expect(validateSlug('Esencia y Grano')).toEqual({ ok: true, slug: 'esenciaygrano' });
  });

  it('rechaza vacío tras normalizar', () => {
    expect(validateSlug('---')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rechaza demasiado corto (< 3)', () => {
    expect(validateSlug('ab')).toEqual({ ok: false, reason: 'too_short' });
  });

  it('rechaza demasiado largo (> 30)', () => {
    expect(validateSlug('a'.repeat(31))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('acepta justo en los límites', () => {
    expect(validateSlug('abc')).toEqual({ ok: true, slug: 'abc' });
    expect(validateSlug('a'.repeat(30))).toEqual({ ok: true, slug: 'a'.repeat(30) });
  });

  it('cada razón tiene mensaje en español', () => {
    expect(slugRejectionMessage('empty')).toMatch(/al menos una letra/i);
    expect(slugRejectionMessage('too_short')).toMatch(/al menos 3/i);
    expect(slugRejectionMessage('too_long')).toMatch(/30/);
  });
});
