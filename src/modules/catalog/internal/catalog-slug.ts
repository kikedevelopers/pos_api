/**
 * Slug del catálogo público: el "nombre de usuario" del negocio en la URL
 * `/catalog/<slug>`.
 *
 * Reglas (las pidió el producto): UNA sola palabra, en minúsculas, solo
 * `[a-z0-9]` — sin espacios, sin acentos, sin símbolos. Ej.: `esenciaygrano`.
 *
 * `normalizeSlug` es la fuente ÚNICA de la verdad: normaliza lo que el usuario
 * escribe ("Esencia y Grano" → "esenciaygrano") en vez de solo rechazarlo, para
 * que el formulario y la comprobación de disponibilidad coincidan siempre con lo
 * que se persiste. El CHECK de la migración (`^[a-z0-9]{3,30}$`) es el mismo
 * criterio en la base: cinturón y tirantes.
 */

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 30;

/** Patrón canónico del slug ya normalizado. Espeja el CHECK de la migración. */
export const SLUG_PATTERN = /^[a-z0-9]{3,30}$/;

/**
 * Normaliza una entrada libre a un slug candidato:
 *   1. separa los diacríticos (NFD) y los descarta → quita tildes/acentos
 *      (incluida la `ñ`, que en NFD se descompone en `n` + tilde → queda `n`).
 *   2. pasa a minúsculas.
 *   3. elimina todo lo que no sea `[a-z0-9]` (espacios, símbolos, emojis).
 *
 * No recorta longitud: eso lo decide la validación, para poder avisar "muy
 * corto/largo" en vez de truncar en silencio.
 */
export function normalizeSlug(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export type SlugValidation =
  | { ok: true; slug: string }
  | { ok: false; reason: 'empty' | 'too_short' | 'too_long' };

/**
 * Normaliza y valida. Devuelve el slug limpio o la razón del rechazo, para que
 * el caller arme el mensaje (en el DTO/acción). No lanza: es puro y testeable.
 */
export function validateSlug(input: string): SlugValidation {
  const slug = normalizeSlug(input);
  if (slug.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (slug.length < SLUG_MIN_LENGTH) {
    return { ok: false, reason: 'too_short' };
  }
  if (slug.length > SLUG_MAX_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, slug };
}

/** Mensaje en español para cada razón de rechazo. */
export function slugRejectionMessage(reason: Exclude<SlugValidation, { ok: true }>['reason']): string {
  switch (reason) {
    case 'empty':
      return 'El nombre del catálogo debe tener al menos una letra o número (sin espacios ni símbolos).';
    case 'too_short':
      return `El nombre del catálogo debe tener al menos ${SLUG_MIN_LENGTH} caracteres.`;
    case 'too_long':
      return `El nombre del catálogo no puede superar los ${SLUG_MAX_LENGTH} caracteres.`;
  }
}
