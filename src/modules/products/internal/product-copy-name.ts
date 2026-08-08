/**
 * Nombre de la COPIA de un producto ("Duplicar item" del inventario).
 *
 * Espejo EXACTO de `productCopyName.ts` de PlacePos: la numeración debe dar el
 * mismo resultado en local y en cloud, o el mismo catálogo produciría nombres
 * distintos según el modo en el que esté el POS.
 *
 * Reglas del dominio:
 *   - La copia se llama `<NOMBRE> COPIA`. Si ese nombre ya está ocupado, se
 *     numera: `<NOMBRE> COPIA 2`, `<NOMBRE> COPIA 3`… hasta encontrar uno libre.
 *   - Duplicar una copia NO encadena sufijos: se le quita el `COPIA`/`COPIA N`
 *     final al nombre de origen antes de construir el candidato. Así
 *     "ARROZ DIANA COPIA" duplicado da "ARROZ DIANA COPIA 2", no
 *     "ARROZ DIANA COPIA COPIA".
 */

/** Sufijo que marca una copia. En mayúsculas: el catálogo se teclea así. */
export const COPY_LABEL = 'COPIA';

/**
 * Tope de intentos al numerar. Red de seguridad contra un bucle infinito si el
 * predicado de "ocupado" fallara siempre; nadie tiene 500 copias del mismo
 * producto.
 */
export const MAX_COPY_ATTEMPTS = 500;

/**
 * ` COPIA` o ` COPIA <n>` al final del nombre. Case-insensitive porque el
 * usuario puede haber renombrado la copia a minúsculas. Exige espacio delante
 * para no mutilar un producto que se llame literalmente "COPIA".
 */
const COPY_SUFFIX_PATTERN = new RegExp(`\\s+${COPY_LABEL}(\\s+\\d+)?\\s*$`, 'i');

/**
 * Quita el sufijo de copia del nombre para obtener la RAÍZ desde la que numerar.
 * Si al quitarlo no queda nada (nombre que es solo " COPIA 3"), devuelve el
 * nombre original trimmed: preferimos un nombre feo a uno vacío, que violaría
 * el CHECK `chk_products_name_not_empty`.
 */
export function stripCopySuffix(name: string): string {
  const trimmed = name.trim();
  const root = trimmed.replace(COPY_SUFFIX_PATTERN, '').trim();
  return root || trimmed;
}

/**
 * Candidato número `attempt` (1-based) para la raíz dada. El primero va SIN
 * número ("ARROZ DIANA COPIA"); del segundo en adelante se numera.
 */
export function buildCopyName(root: string, attempt: number): string {
  return attempt <= 1 ? `${root} ${COPY_LABEL}` : `${root} ${COPY_LABEL} ${attempt}`;
}

/**
 * Resuelve el primer nombre de copia LIBRE para `sourceName`.
 *
 * `isTaken` decide si un candidato ya existe dentro de la company. Ver la nota
 * del action sobre por qué la comprobación NO filtra archivados.
 */
export async function resolveCopyName(
  sourceName: string,
  isTaken: (candidate: string) => Promise<boolean>,
  maxAttempts: number = MAX_COPY_ATTEMPTS,
): Promise<string> {
  const root = stripCopySuffix(sourceName);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = buildCopyName(root, attempt);
    if (!(await isTaken(candidate))) {
      return candidate;
    }
  }

  throw new Error(
    `Hay demasiadas copias de "${root}". Renombra o archiva alguna antes de duplicar.`,
  );
}
