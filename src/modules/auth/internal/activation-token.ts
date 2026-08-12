import {
  evaluateOneTimeToken,
  expiresInDays,
  generateOneTimeToken,
  hashOneTimeToken,
  looksLikeOneTimeToken,
  oneTimeHashMatches,
  type StoredOneTimeToken,
  type TokenRejection,
} from './one-time-token';

/**
 * Token de activación de cuenta.
 *
 * El mecanismo (generar, hashear, evaluar) vive en `one-time-token.ts`, que
 * comparte con la recuperación de contraseña: son el mismo artefacto. Aquí solo
 * queda lo propio de la activación — cuánto vive, a dónde apunta el enlace y
 * qué se le dice al usuario cuando no sirve.
 */

export const generateActivationToken = generateOneTimeToken;
export const hashActivationToken = hashOneTimeToken;
export const activationHashMatches = oneTimeHashMatches;
export const looksLikeActivationToken = looksLikeOneTimeToken;
export const evaluateActivationToken = evaluateOneTimeToken;

export type ActivationRejection = TokenRejection;
export type StoredActivationToken = StoredOneTimeToken;

/** Vigencia del enlace. Suficiente para quien no lee el correo el mismo día. */
export const ACTIVATION_TOKEN_TTL_DAYS = 7;

/** Caducidad a partir del momento de emisión. */
export const activationExpiresAt = (from: Date, days: number = ACTIVATION_TOKEN_TTL_DAYS): Date =>
  expiresInDays(from, days);

/** Mensaje para el usuario final según el motivo del rechazo. */
export const describeActivationRejection = (reason: ActivationRejection): string => {
  switch (reason) {
    case 'expired':
      return 'El enlace de activación venció. Escríbenos para enviarte uno nuevo.';
    case 'used':
      return 'Este enlace ya se usó. Si tu cuenta está activa, inicia sesión normalmente.';
    default:
      return 'El enlace de activación no es válido. Revisa que lo hayas copiado completo.';
  }
};

/**
 * URL que se pone en el botón del correo. La base es configurable porque en
 * producción apunta a la landing (`placepos.kikedevs.com`) y en desarrollo al
 * servidor local que se esté usando.
 */
export const buildActivationUrl = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/activar?token=${encodeURIComponent(token)}`;
