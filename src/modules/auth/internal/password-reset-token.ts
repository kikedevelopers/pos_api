import {
  evaluateOneTimeToken,
  expiresInHours,
  generateOneTimeToken,
  hashOneTimeToken,
  looksLikeOneTimeToken,
  type TokenRejection,
} from './one-time-token';

/**
 * Token de recuperación de contraseña. Comparte mecanismo con la activación
 * (`one-time-token.ts`); aquí vive lo suyo: una vigencia mucho más corta y el
 * enlace que abre la app.
 */

export const generatePasswordResetToken = generateOneTimeToken;
export const hashPasswordResetToken = hashOneTimeToken;
export const looksLikePasswordResetToken = looksLikeOneTimeToken;
export const evaluatePasswordResetToken = evaluateOneTimeToken;

export type PasswordResetRejection = TokenRejection;

/**
 * Dos horas, frente a los 7 días de la activación.
 *
 * Este token permite CAMBIAR la contraseña de una cuenta viva: quien acceda al
 * buzón se lleva la cuenta entera. La activación, en cambio, solo confirma una
 * dirección. A menos ventana, menos daño posible — y quien pide recuperar su
 * contraseña está delante del computador en ese momento, así que dos horas
 * sobran.
 */
export const PASSWORD_RESET_TTL_HOURS = 2;

export const passwordResetExpiresAt = (
  from: Date,
  hours: number = PASSWORD_RESET_TTL_HOURS,
): Date => expiresInHours(from, hours);

/** Mensaje para el usuario final según el motivo del rechazo. */
export const describePasswordResetRejection = (reason: PasswordResetRejection): string => {
  switch (reason) {
    case 'expired':
      return 'El enlace para cambiar la contraseña venció. Pide uno nuevo desde "¿Olvidaste tu contraseña?".';
    case 'used':
      return 'Este enlace ya se usó. Si no fuiste tú, pide uno nuevo y avísanos.';
    default:
      return 'El enlace no es válido. Revisa que lo hayas abierto completo desde el correo.';
  }
};

/**
 * Enlace del correo. Apunta a una página HTTPS de la landing, NO directamente
 * al esquema `placepos://`: buena parte de los clientes de correo se niegan a
 * abrir enlaces con esquemas propios, y el botón simplemente no haría nada. La
 * página es la que lanza la app.
 */
export const buildPasswordResetUrl = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/restablecer?token=${encodeURIComponent(token)}`;

/**
 * Deep link que abre PlacePOS en la pantalla de contraseña nueva. Lo dispara la
 * página del navegador, y el proceso principal de Electron lo traduce a una
 * ruta de la app.
 */
export const buildPasswordResetDeepLink = (token: string): string =>
  `placepos://reset-password?token=${encodeURIComponent(token)}`;
