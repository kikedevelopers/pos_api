/**
 * Tarjetas que el chat dibuja TAL CUAL las produce el servidor.
 *
 * La vista previa de un pedido no puede depender del texto del modelo: si el
 * modelo copiara mal una cantidad o un precio, el usuario confirmaría algo
 * distinto de lo que se crea. Por eso el resultado de la herramienta viaja al
 * cliente como un evento SSE `card` aparte, con los datos exactos del snapshot
 * guardado, y el modelo solo acompaña con una frase.
 *
 * Puro: decide la tarjeta a partir del nombre y la respuesta de la herramienta
 * (ya sin campos de ganancia si el usuario no puede verlos).
 */

export type AiToolCard =
  | { kind: 'sale_preview'; data: Record<string, unknown> }
  | { kind: 'sale_created'; data: Record<string, unknown> };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const cardForToolResult = (
  name: string,
  response: Record<string, unknown>,
): AiToolCard | null => {
  if (name === 'prepare_sale' && response.status === 'confirmation_required') {
    const summary = asRecord(response.summary);
    return summary ? { kind: 'sale_preview', data: summary } : null;
  }
  if (name === 'confirm_sale' && response.status === 'executed') {
    const order = asRecord(response.order);
    return order ? { kind: 'sale_created', data: order } : null;
  }
  return null;
};
