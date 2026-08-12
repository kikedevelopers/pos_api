import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token de activación: generación, hash y validación. Puro y testeado — es lo
 * único que separa "activar mi cuenta" de "activar la cuenta de cualquiera".
 */

/**
 * 32 bytes de aleatoriedad criptográfica (64 caracteres hex). Un token de
 * activación es una credencial de un solo uso que viaja en una URL: tiene que
 * ser imposible de adivinar y no puede depender de datos del usuario.
 */
export const generateActivationToken = (): string => randomBytes(32).toString('hex');

/** SHA-256 hex. Es lo ÚNICO que se guarda en la base. */
export const hashActivationToken = (token: string): string =>
  createHash('sha256').update(token.trim()).digest('hex');

/**
 * Comparación en tiempo constante de dos hashes. Un `===` filtra por timing en
 * cuántos caracteres coincidieron, que es justo lo que necesita un atacante
 * para ir adivinando el token byte a byte.
 */
export const activationHashMatches = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` exige la misma longitud; distintas = distinto hash.
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Un token con forma válida: 64 caracteres hexadecimales. Filtrar temprano
 * evita ir a la base con cualquier basura que llegue en la URL.
 */
export const looksLikeActivationToken = (value: string): boolean =>
  /^[0-9a-f]{64}$/i.test(value.trim());

/** Vigencia del enlace. Suficiente para quien no lee el correo el mismo día. */
export const ACTIVATION_TOKEN_TTL_DAYS = 7;

/** Caducidad a partir del momento de emisión. */
export const activationExpiresAt = (from: Date, days: number = ACTIVATION_TOKEN_TTL_DAYS): Date =>
  new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

/** Motivos por los que un token no sirve. Los distingue la UI de activación. */
export type ActivationRejection = 'invalid' | 'expired' | 'used';

/** Lo mínimo que necesita `evaluateActivationToken` de un token guardado. */
export interface StoredActivationToken {
  expires_at: Date;
  used_at: Date | null;
}

/**
 * Decide si un token guardado sigue sirviendo. Puro: recibe el registro y el
 * `now`, para poder testear la caducidad sin tocar el reloj.
 *
 * El caso válido DEVUELVE el registro (ya sin `null`), para que quien llama no
 * tenga que asegurarle al compilador algo que esta función acaba de comprobar.
 */
export const evaluateActivationToken = <T extends StoredActivationToken>(
  record: T | null,
  now: Date,
): { valid: true; record: T } | { valid: false; reason: ActivationRejection } => {
  if (!record) {
    return { valid: false, reason: 'invalid' };
  }
  if (record.used_at !== null) {
    return { valid: false, reason: 'used' };
  }
  if (record.expires_at.getTime() <= now.getTime()) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, record };
};

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
