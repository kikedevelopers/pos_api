/**
 * Normalización y validación de direcciones de correo. Puro y testeado: es la
 * puerta por la que entra todo destinatario, así que un error aquí se convierte
 * en correos que no llegan.
 */

/**
 * Validación deliberadamente conservadora: local@dominio.tld, sin espacios, sin
 * comas (separan direcciones) y con al menos un punto en el dominio. No intenta
 * implementar el RFC 5322 completo — el proveedor hace la validación final; lo
 * que se busca aquí es rechazar temprano lo obviamente malo.
 */
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>.]+(\.[^\s@,;<>.]+)+$/;

/** `true` si la dirección tiene forma de correo enviable. */
export const isValidEmail = (value: string): boolean => EMAIL_RE.test(value.trim());

/**
 * Deja la dirección lista para el proveedor: sin espacios sobrantes y con el
 * dominio en minúsculas (la parte local del RFC es sensible a mayúsculas, así
 * que NO se toca).
 */
export const normalizeEmail = (value: string): string => {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) {
    return trimmed;
  }
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
};

/**
 * Normaliza una lista de destinatarios: acepta un string suelto o un arreglo,
 * separa por coma/punto y coma, quita vacíos y deduplica sin alterar el orden.
 */
export const normalizeRecipients = (input: string | string[] | undefined): string[] => {
  const raw = Array.isArray(input) ? input : [input ?? ''];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const chunk of raw) {
    for (const piece of String(chunk ?? '').split(/[,;]/)) {
      const email = normalizeEmail(piece);
      if (email.length === 0) {
        continue;
      }
      const key = email.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(email);
    }
  }

  return result;
};

/** Direcciones de la lista que NO tienen forma válida. */
export const invalidRecipients = (recipients: string[]): string[] =>
  recipients.filter((email) => !isValidEmail(email));

/**
 * Oculta el grueso de la dirección para poder loguearla sin exponer el correo
 * completo: `kike@esenciaygrano.com` → `k***e@esenciaygrano.com`.
 */
export const maskEmail = (value: string): string => {
  const email = value.trim();
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) {
    return `${local[0] ?? '*'}***${domain}`;
  }
  return `${local[0]}***${local[local.length - 1]}${domain}`;
};

/**
 * Extrae el correo de un remitente con nombre: `PlacePOS <no-reply@x.com>` →
 * `no-reply@x.com`. Si no trae ángulos, devuelve el valor tal cual.
 */
export const extractAddress = (from: string): string => {
  const match = /<([^>]+)>/.exec(from);
  return (match ? match[1] : from).trim();
};

/** Dominio del remitente, en minúsculas. Vacío si no se puede determinar. */
export const senderDomain = (from: string): string => {
  const address = extractAddress(from);
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).toLowerCase();
};
