import {
  extractAddress,
  invalidRecipients,
  isValidEmail,
  maskEmail,
  normalizeEmail,
  normalizeRecipients,
  senderDomain,
} from '../internal/mail-address';

describe('isValidEmail', () => {
  it('acepta direcciones normales', () => {
    for (const email of [
      'kike@esenciaygrano.com',
      'no-reply@kikedevs.com',
      'a.b+tag@sub.dominio.co',
      'u@x.io',
    ]) {
      expect(isValidEmail(email)).toBe(true);
    }
  });

  it('rechaza lo que no puede salir', () => {
    for (const bad of [
      '',
      '   ',
      'sin-arroba.com',
      '@dominio.com',
      'local@',
      'local@dominio', // sin TLD: un typo clásico que el proveedor cobra caro
      'con espacio@dominio.com',
      'dos@arrobas@dominio.com',
      'coma,dentro@dominio.com',
      '<script>@dominio.com',
    ]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });

  it('ignora los espacios de los bordes', () => {
    expect(isValidEmail('  kike@esenciaygrano.com  ')).toBe(true);
  });
});

describe('normalizeEmail', () => {
  it('baja el dominio a minúsculas y respeta la parte local', () => {
    // La parte local es sensible a mayúsculas según el RFC: tocarla podría
    // dirigir el correo a otro buzón.
    expect(normalizeEmail('  Kike@ESENCIAyGrano.COM ')).toBe('Kike@esenciaygrano.com');
  });

  it('devuelve el valor recortado si no hay arroba', () => {
    expect(normalizeEmail('  basura  ')).toBe('basura');
  });
});

describe('normalizeRecipients', () => {
  it('acepta un string suelto', () => {
    expect(normalizeRecipients('kike@x.com')).toEqual(['kike@x.com']);
  });

  it('acepta un arreglo', () => {
    expect(normalizeRecipients(['a@x.com', 'b@x.com'])).toEqual(['a@x.com', 'b@x.com']);
  });

  it('separa por coma y punto y coma', () => {
    expect(normalizeRecipients('a@x.com, b@x.com; c@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
  });

  it('deduplica sin distinguir mayúsculas y conserva el orden', () => {
    expect(normalizeRecipients(['B@x.com', 'a@x.com', 'b@X.com'])).toEqual(['B@x.com', 'a@x.com']);
  });

  it('descarta vacíos y separadores sueltos', () => {
    expect(normalizeRecipients(' , ; ,a@x.com,,')).toEqual(['a@x.com']);
  });

  it('devuelve lista vacía para undefined o cadena vacía', () => {
    expect(normalizeRecipients(undefined)).toEqual([]);
    expect(normalizeRecipients('')).toEqual([]);
    expect(normalizeRecipients([])).toEqual([]);
  });
});

describe('invalidRecipients', () => {
  it('devuelve solo las direcciones malas', () => {
    expect(invalidRecipients(['ok@x.com', 'malo', 'otro@y.com'])).toEqual(['malo']);
  });

  it('devuelve vacío cuando todas sirven', () => {
    expect(invalidRecipients(['ok@x.com'])).toEqual([]);
  });
});

describe('maskEmail', () => {
  it('deja ver el dominio y esconde el grueso de la parte local', () => {
    expect(maskEmail('kike@esenciaygrano.com')).toBe('k***e@esenciaygrano.com');
  });

  it('maneja partes locales muy cortas sin exponerlas', () => {
    expect(maskEmail('ab@x.com')).toBe('a***@x.com');
    expect(maskEmail('a@x.com')).toBe('a***@x.com');
  });

  it('no revela nada si el valor no parece un correo', () => {
    expect(maskEmail('basura')).toBe('***');
    expect(maskEmail('@x.com')).toBe('***');
  });
});

describe('extractAddress / senderDomain', () => {
  it('saca el correo de un remitente con nombre', () => {
    expect(extractAddress('PlacePOS <no-reply@kikedevs.com>')).toBe('no-reply@kikedevs.com');
  });

  it('devuelve el valor tal cual si no trae ángulos', () => {
    expect(extractAddress('no-reply@kikedevs.com')).toBe('no-reply@kikedevs.com');
  });

  it('devuelve el dominio en minúsculas', () => {
    expect(senderDomain('PlacePOS <No-Reply@KikeDevs.com>')).toBe('kikedevs.com');
    expect(senderDomain('sin-dominio')).toBe('');
  });
});
