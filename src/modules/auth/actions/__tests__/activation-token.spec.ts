import {
  ACTIVATION_TOKEN_TTL_DAYS,
  activationExpiresAt,
  activationHashMatches,
  buildActivationUrl,
  describeActivationRejection,
  evaluateActivationToken,
  generateActivationToken,
  hashActivationToken,
  looksLikeActivationToken,
} from '../../internal/activation-token';

describe('generateActivationToken', () => {
  it('produce 64 caracteres hexadecimales', () => {
    const token = generateActivationToken();
    expect(token).toHaveLength(64);
    expect(looksLikeActivationToken(token)).toBe(true);
  });

  it('nunca repite un token', () => {
    // Es una credencial: dos iguales significarían poder activar la cuenta de
    // otro. 32 bytes de `randomBytes` lo hacen imposible en la práctica; este
    // test protege contra un cambio descuidado a algo predecible.
    const tokens = new Set(Array.from({ length: 200 }, () => generateActivationToken()));
    expect(tokens.size).toBe(200);
  });
});

describe('hashActivationToken', () => {
  it('es estable y del largo de un SHA-256', () => {
    const token = 'a'.repeat(64);
    expect(hashActivationToken(token)).toBe(hashActivationToken(token));
    expect(hashActivationToken(token)).toHaveLength(64);
  });

  it('ignora los espacios de los bordes', () => {
    // El token llega desde una URL: puede traer basura al copiarlo a mano.
    expect(hashActivationToken('  abc  ')).toBe(hashActivationToken('abc'));
  });

  it('un cambio mínimo cambia el hash entero', () => {
    expect(hashActivationToken('a'.repeat(64))).not.toBe(hashActivationToken(`${'a'.repeat(63)}b`));
  });

  it('nunca devuelve el token en claro', () => {
    const token = generateActivationToken();
    expect(hashActivationToken(token)).not.toBe(token);
  });
});

describe('activationHashMatches', () => {
  it('reconoce hashes iguales y rechaza distintos', () => {
    const hash = hashActivationToken('x');
    expect(activationHashMatches(hash, hash)).toBe(true);
    expect(activationHashMatches(hash, hashActivationToken('y'))).toBe(false);
  });

  it('no revienta con longitudes distintas', () => {
    // `timingSafeEqual` lanza si difieren; el helper tiene que absorberlo.
    expect(activationHashMatches('abc', 'abcdef')).toBe(false);
    expect(activationHashMatches('', 'x')).toBe(false);
  });
});

describe('looksLikeActivationToken', () => {
  it('acepta 64 hex en cualquier caja', () => {
    expect(looksLikeActivationToken('0'.repeat(64))).toBe(true);
    expect(looksLikeActivationToken('ABCDEF'.padEnd(64, '0'))).toBe(true);
    expect(looksLikeActivationToken(`  ${'f'.repeat(64)}  `)).toBe(true);
  });

  it('rechaza lo que no puede ser un token', () => {
    for (const bad of [
      '',
      '   ',
      'a'.repeat(63),
      'a'.repeat(65),
      `${'g'.repeat(64)}`, // 'g' no es hexadecimal
      "0'; DROP TABLE users;--".padEnd(64, '0'),
      '../../etc/passwd',
    ]) {
      expect(looksLikeActivationToken(bad)).toBe(false);
    }
  });
});

describe('activationExpiresAt', () => {
  it('vence a los 7 días por defecto', () => {
    const from = new Date('2026-08-12T10:00:00.000Z');
    expect(activationExpiresAt(from).toISOString()).toBe('2026-08-19T10:00:00.000Z');
    expect(ACTIVATION_TOKEN_TTL_DAYS).toBe(7);
  });

  it('admite otra vigencia', () => {
    const from = new Date('2026-08-12T10:00:00.000Z');
    expect(activationExpiresAt(from, 1).toISOString()).toBe('2026-08-13T10:00:00.000Z');
  });
});

describe('evaluateActivationToken', () => {
  const NOW = new Date('2026-08-12T10:00:00.000Z');
  const future = new Date('2026-08-19T10:00:00.000Z');
  const past = new Date('2026-08-05T10:00:00.000Z');

  it('acepta un token vigente y sin usar, y devuelve el registro', () => {
    const record = { expires_at: future, used_at: null };
    const verdict = evaluateActivationToken(record, NOW);
    expect(verdict.valid).toBe(true);
    // Devolver el registro es lo que evita los `!` en quien llama.
    expect(verdict.valid && verdict.record).toBe(record);
  });

  it('un token inexistente es inválido', () => {
    expect(evaluateActivationToken(null, NOW)).toEqual({ valid: false, reason: 'invalid' });
  });

  it('un token ya canjeado se distingue de uno inválido', () => {
    // La diferencia importa: "ya se usó" suele ser un doble clic, y la UI
    // responde distinto que ante un enlace falso.
    expect(evaluateActivationToken({ expires_at: future, used_at: NOW }, NOW)).toEqual({
      valid: false,
      reason: 'used',
    });
  });

  it('un token vencido es vencido', () => {
    expect(evaluateActivationToken({ expires_at: past, used_at: null }, NOW)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('vencer JUSTO ahora ya no sirve', () => {
    expect(evaluateActivationToken({ expires_at: NOW, used_at: null }, NOW)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('un token usado Y vencido reporta que se usó', () => {
    // El motivo más accionable manda: si ya lo usó, su cuenta puede estar lista.
    expect(evaluateActivationToken({ expires_at: past, used_at: past }, NOW)).toEqual({
      valid: false,
      reason: 'used',
    });
  });
});

describe('describeActivationRejection', () => {
  it('da un mensaje distinto y accionable por motivo', () => {
    const messages = (['invalid', 'expired', 'used'] as const).map(describeActivationRejection);
    expect(messages[0]).toContain('no es válido');
    expect(messages[1]).toContain('venció');
    expect(messages[2]).toContain('ya se usó');
    expect(new Set(messages).size).toBe(3);
  });
});

describe('buildActivationUrl', () => {
  it('arma la URL de la página de activación', () => {
    expect(buildActivationUrl('https://placepos.kikedevs.com', 'abc123')).toBe(
      'https://placepos.kikedevs.com/activar?token=abc123',
    );
  });

  it('no duplica la barra final de la base', () => {
    expect(buildActivationUrl('https://placepos.kikedevs.com/', 'abc')).toBe(
      'https://placepos.kikedevs.com/activar?token=abc',
    );
    expect(buildActivationUrl('http://localhost:5173///', 'abc')).toBe(
      'http://localhost:5173/activar?token=abc',
    );
  });

  it('escapa el token en la query', () => {
    expect(buildActivationUrl('https://x.com', 'a b&c=d')).toBe(
      'https://x.com/activar?token=a%20b%26c%3Dd',
    );
  });
});
