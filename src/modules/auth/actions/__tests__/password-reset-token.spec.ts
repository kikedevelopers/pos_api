import { ACTIVATION_TOKEN_TTL_DAYS } from '../../internal/activation-token';
import {
  buildPasswordResetDeepLink,
  buildPasswordResetUrl,
  describePasswordResetRejection,
  evaluatePasswordResetToken,
  generatePasswordResetToken,
  hashPasswordResetToken,
  looksLikePasswordResetToken,
  PASSWORD_RESET_TTL_HOURS,
  passwordResetExpiresAt,
} from '../../internal/password-reset-token';

describe('token de recuperación', () => {
  it('tiene la forma de un token de un solo uso', () => {
    const token = generatePasswordResetToken();
    expect(token).toHaveLength(64);
    expect(looksLikePasswordResetToken(token)).toBe(true);
  });

  it('nunca se guarda en claro', () => {
    const token = generatePasswordResetToken();
    expect(hashPasswordResetToken(token)).not.toBe(token);
    expect(hashPasswordResetToken(token)).toHaveLength(64);
  });

  it('vence MUCHO antes que el de activación', () => {
    // Este token permite tomar el control de una cuenta viva; el de activación
    // solo confirma una dirección. La ventana tiene que ser mínima.
    expect(PASSWORD_RESET_TTL_HOURS).toBe(2);
    const ttlDeActivacionEnHoras = ACTIVATION_TOKEN_TTL_DAYS * 24;
    expect(PASSWORD_RESET_TTL_HOURS).toBeLessThan(ttlDeActivacionEnHoras);
  });

  it('calcula el vencimiento en horas', () => {
    const from = new Date('2026-08-12T10:00:00.000Z');
    expect(passwordResetExpiresAt(from).toISOString()).toBe('2026-08-12T12:00:00.000Z');
    expect(passwordResetExpiresAt(from, 1).toISOString()).toBe('2026-08-12T11:00:00.000Z');
  });
});

describe('evaluatePasswordResetToken', () => {
  const NOW = new Date('2026-08-12T10:00:00.000Z');

  it('acepta el vigente sin usar', () => {
    const record = { expires_at: new Date('2026-08-12T11:00:00.000Z'), used_at: null };
    expect(evaluatePasswordResetToken(record, NOW)).toEqual({ valid: true, record });
  });

  it('distingue inválido, vencido y usado', () => {
    expect(evaluatePasswordResetToken(null, NOW)).toEqual({ valid: false, reason: 'invalid' });
    expect(
      evaluatePasswordResetToken(
        { expires_at: new Date('2026-08-12T09:00:00Z'), used_at: null },
        NOW,
      ),
    ).toEqual({ valid: false, reason: 'expired' });
    expect(
      evaluatePasswordResetToken(
        { expires_at: new Date('2026-08-12T11:00:00Z'), used_at: NOW },
        NOW,
      ),
    ).toEqual({ valid: false, reason: 'used' });
  });
});

describe('describePasswordResetRejection', () => {
  it('cada motivo dice qué hacer a continuación', () => {
    expect(describePasswordResetRejection('expired')).toContain('Pide uno nuevo');
    expect(describePasswordResetRejection('used')).toContain('ya se usó');
    expect(describePasswordResetRejection('invalid')).toContain('no es válido');
  });

  it('el "ya se usó" avisa por si no fue el dueño', () => {
    // Un token consumido que el dueño no canjeó es la señal temprana de que
    // alguien más tiene su correo.
    expect(describePasswordResetRejection('used')).toContain('avísanos');
  });
});

describe('buildPasswordResetUrl', () => {
  it('apunta a la página de la landing, NO al esquema propio', () => {
    // Buena parte de los clientes de correo se niegan a abrir `placepos://`:
    // el botón simplemente no haría nada. La página es la que lanza la app.
    const url = buildPasswordResetUrl('https://placepos.kikedevs.com', 'abc123');
    expect(url).toBe('https://placepos.kikedevs.com/restablecer?token=abc123');
    expect(url.startsWith('https://')).toBe(true);
  });

  it('no duplica la barra final de la base', () => {
    expect(buildPasswordResetUrl('http://localhost:5173///', 'abc')).toBe(
      'http://localhost:5173/restablecer?token=abc',
    );
  });

  it('escapa el token en la query', () => {
    expect(buildPasswordResetUrl('https://x.com', 'a b&c')).toBe(
      'https://x.com/restablecer?token=a%20b%26c',
    );
  });
});

describe('buildPasswordResetDeepLink', () => {
  it('usa el esquema de la app con la ruta de contraseña', () => {
    expect(buildPasswordResetDeepLink('abc123')).toBe('placepos://reset-password?token=abc123');
  });

  it('escapa el token', () => {
    expect(buildPasswordResetDeepLink('a b&c')).toBe('placepos://reset-password?token=a%20b%26c');
  });
});
