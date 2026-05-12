/**
 * Formatea un número de ticket con prefix/suffix. Espejo del helper
 * `formatNumber(prefix, number)` de PlacePos
 * (`placepos/src/main/server/routes/purchases.routes.ts`):
 *
 *   `${prefix}-${String(number).padStart(3, '0')}`
 *
 * Generalizado para soportar `suffix` opcional (extensión de Fase 10 frente
 * al cliente de escritorio). Si `prefix` o `suffix` son null/undefined no
 * añade el separador. Si AMBOS son null, devuelve solo el number padded.
 *
 * Ejemplos:
 *   formatTicketNumber('F', null, 1)   -> 'F-001'
 *   formatTicketNumber(null, null, 42) -> '042'
 *   formatTicketNumber('A', 'B', 7)    -> 'A-007-B'
 *   formatTicketNumber('', '', 9)      -> '009'    (string vacío == sin prefijo)
 */
export const TICKET_NUMBER_PAD_LENGTH = 3;

export function formatTicketNumber(
  prefix: string | null | undefined,
  suffix: string | null | undefined,
  number: number,
): string {
  const padded = String(number).padStart(TICKET_NUMBER_PAD_LENGTH, '0');
  const hasPrefix = typeof prefix === 'string' && prefix.length > 0;
  const hasSuffix = typeof suffix === 'string' && suffix.length > 0;

  if (hasPrefix && hasSuffix) {
    return `${prefix}-${padded}-${suffix}`;
  }
  if (hasPrefix) {
    return `${prefix}-${padded}`;
  }
  if (hasSuffix) {
    return `${padded}-${suffix}`;
  }
  return padded;
}
