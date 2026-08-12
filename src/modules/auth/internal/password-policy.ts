/**
 * Reglas de contraseña de PlacePOS. Puras y testeadas.
 *
 * Son las MISMAS que el usuario ve al registrarse (el Zod de placepos y el
 * formulario del panel): mínimo 8, una mayúscula, una minúscula y un carácter
 * especial. Aquí viven en el servidor para que el restablecimiento no pueda
 * saltárselas — una validación que solo existe en el cliente es una sugerencia,
 * no una regla.
 */

export interface PasswordRule {
  /** Identificador estable; el cliente puede usarlo para marcar la lista. */
  key: 'length' | 'uppercase' | 'lowercase' | 'special';
  /** Texto tal como se le muestra al usuario. */
  label: string;
  test: (password: string) => boolean;
}

/** Tope: argon2 no tiene problema, pero un campo sin límite es una invitación. */
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_RULES: readonly PasswordRule[] = [
  { key: 'length', label: 'Mínimo 8 caracteres', test: (p) => p.length >= 8 },
  { key: 'uppercase', label: 'Una letra mayúscula', test: (p) => /[A-Z]/.test(p) },
  { key: 'lowercase', label: 'Una letra minúscula', test: (p) => /[a-z]/.test(p) },
  { key: 'special', label: 'Un carácter especial', test: (p) => /[^A-Za-z0-9]/.test(p) },
] as const;

/** Reglas que la contraseña NO cumple. Vacío = sirve. */
export const failedPasswordRules = (password: string): PasswordRule[] =>
  PASSWORD_RULES.filter((rule) => !rule.test(password));

export const isValidPassword = (password: string): boolean =>
  password.length <= PASSWORD_MAX_LENGTH && failedPasswordRules(password).length === 0;

/**
 * Mensaje de error listo para el usuario. Enumera lo que falta en vez de soltar
 * un "contraseña inválida": quien no sabe qué le falta, prueba a ciegas.
 */
export const describePasswordFailure = (password: string): string => {
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `La contraseña no puede exceder ${PASSWORD_MAX_LENGTH} caracteres.`;
  }
  const failed = failedPasswordRules(password);
  if (failed.length === 0) {
    return '';
  }
  const missing = failed.map((rule) => rule.label.toLowerCase()).join(', ');
  return `La contraseña no cumple los requisitos: ${missing}.`;
};
