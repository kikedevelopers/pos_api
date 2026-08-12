import {
  describePasswordFailure,
  failedPasswordRules,
  isValidPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_RULES,
} from '../../internal/password-policy';

describe('PASSWORD_RULES', () => {
  it('son las mismas cuatro que el usuario ve al registrarse', () => {
    // Si aquí sobrara o faltara una regla, alguien podría no poder restablecer
    // la contraseña que sí le aceptaron al registrarse (o al revés).
    expect(PASSWORD_RULES.map((rule) => rule.key)).toEqual([
      'length',
      'uppercase',
      'lowercase',
      'special',
    ]);
  });
});

describe('isValidPassword', () => {
  it('acepta una contraseña que cumple las cuatro reglas', () => {
    for (const password of ['Password1!', 'aB3$efgh', 'Contraseña.2026', 'Xy!zXy!z']) {
      expect(isValidPassword(password)).toBe(true);
    }
  });

  it('rechaza por cada regla incumplida', () => {
    expect(isValidPassword('Ab1!')).toBe(false); // corta
    expect(isValidPassword('password1!')).toBe(false); // sin mayúscula
    expect(isValidPassword('PASSWORD1!')).toBe(false); // sin minúscula
    expect(isValidPassword('Password12')).toBe(false); // sin especial
    expect(isValidPassword('')).toBe(false);
  });

  it('rechaza una contraseña más larga que el tope', () => {
    // Sin tope, el campo es una invitación a mandar megabytes al hasher.
    const enorme = `Aa1!${'x'.repeat(PASSWORD_MAX_LENGTH)}`;
    expect(isValidPassword(enorme)).toBe(false);
    expect(isValidPassword(`Aa1!${'x'.repeat(PASSWORD_MAX_LENGTH - 4)}`)).toBe(true);
  });

  it('acepta espacios y acentos como caracteres válidos', () => {
    // Una frase de paso es mejor contraseña que "Abc123!"; no hay motivo para
    // prohibirla.
    expect(isValidPassword('Mi Contraseña Larga 1')).toBe(true);
  });
});

describe('failedPasswordRules', () => {
  it('devuelve exactamente las reglas que faltan', () => {
    expect(failedPasswordRules('Password1!').map((r) => r.key)).toEqual([]);
    expect(failedPasswordRules('password').map((r) => r.key)).toEqual(['uppercase', 'special']);
    expect(failedPasswordRules('abc').map((r) => r.key)).toEqual([
      'length',
      'uppercase',
      'special',
    ]);
  });
});

describe('describePasswordFailure', () => {
  it('enumera lo que falta en vez de decir "inválida"', () => {
    // Quien no sabe qué le falta, prueba a ciegas.
    const message = describePasswordFailure('password');
    expect(message).toContain('mayúscula');
    expect(message).toContain('carácter especial');
    expect(message).not.toContain('minúscula');
  });

  it('devuelve cadena vacía si la contraseña sirve', () => {
    expect(describePasswordFailure('Password1!')).toBe('');
  });

  it('el exceso de longitud tiene su propio mensaje', () => {
    const message = describePasswordFailure(`Aa1!${'x'.repeat(PASSWORD_MAX_LENGTH)}`);
    expect(message).toContain(String(PASSWORD_MAX_LENGTH));
    expect(message).not.toContain('requisitos');
  });

  it('nunca devuelve la contraseña dentro del mensaje', () => {
    // El mensaje viaja al cliente y acaba en pantalla; la contraseña no puede
    // ir dentro.
    expect(describePasswordFailure('secreto')).not.toContain('secreto');
  });
});
