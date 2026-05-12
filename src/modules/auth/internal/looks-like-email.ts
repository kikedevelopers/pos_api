/**
 * Heurística para decidir si el `username` recibido en el login luce como
 * email. Si trae un `@`, primero buscamos en `users`; si no, en `employees`.
 *
 * No es un EmailValidator estricto a propósito: si un user tiene email con
 * forma rara (que el `@IsEmail` del register hubiera rechazado) ya no existe
 * en DB; y si un employee se llama `kike@ares.dev` (también raro pero
 * permitido por DB), igual lo buscaríamos como user → no encontraríamos → el
 * caller hace fallback. El peor caso es un round-trip extra a DB, NO una
 * autenticación cruzada.
 */
export function looksLikeEmail(value: string): boolean {
  return value.includes('@');
}
