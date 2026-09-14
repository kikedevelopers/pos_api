import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Mecanismo de token de un solo uso que viaja por correo: generación, hash y
 * validación. Puro y testeado.
 *
 * Lo comparten la activación de cuenta y la recuperación de contraseña porque
 * son literalmente el mismo artefacto — un secreto de un solo uso, guardado
 * hasheado y con caducidad. Lo único que cambia entre ellos es cuánto vive y a
 * dónde apunta el enlace.
 */

/**
 * 32 bytes de aleatoriedad criptográfica (64 caracteres hex). Estos tokens son
 * credenciales que viajan en una URL: tienen que ser imposibles de adivinar y
 * no pueden depender de ningún dato del usuario.
 */
export const generateOneTimeToken = (): string => randomBytes(32).toString('hex');

/** SHA-256 hex. Es lo ÚNICO que se guarda en la base. */
export const hashOneTimeToken = (token: string): string =>
  createHash('sha256').update(token.trim()).digest('hex');

/**
 * Comparación en tiempo constante de dos hashes. Un `===` filtra por timing en
 * cuántos caracteres coincidieron, que es justo lo que necesita un atacante
 * para ir adivinando el token byte a byte.
 */
export const oneTimeHashMatches = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` exige la misma longitud; distintas = distinto hash.
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Un token con forma válida: 64 caracteres hexadecimales. Filtrar temprano
 * evita ir a la base con cualquier basura que llegue en la URL.
 */
export const looksLikeOneTimeToken = (value: string): boolean =>
  /^[0-9a-f]{64}$/i.test(value.trim());

/** Caducidad a partir del momento de emisión. */
export const expiresInDays = (from: Date, days: number): Date =>
  new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

/** Caducidad corta, en horas. La usa la recuperación de contraseña. */
export const expiresInHours = (from: Date, hours: number): Date =>
  new Date(from.getTime() + hours * 60 * 60 * 1000);

/** Motivos por los que un token no sirve. Los distingue la UI. */
export type TokenRejection = 'invalid' | 'expired' | 'used';

/** Lo mínimo que necesita `evaluateOneTimeToken` de un token guardado. */
export interface StoredOneTimeToken {
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
export const evaluateOneTimeToken = <T extends StoredOneTimeToken>(
  record: T | null,
  now: Date,
): { valid: true; record: T } | { valid: false; reason: TokenRejection } => {
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
